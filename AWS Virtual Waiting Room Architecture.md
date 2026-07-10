# **High-Throughput DynamoDB Virtual Waiting Room: The Zero-Write Passive Promotion Architecture**

The challenge of funneling up to ten million concurrent users into a scarce-resource purchasing flow—without crashing downstream systems or compromising fairness—represents one of the most extreme tests of distributed system design1. When dealing with high-demand ticketing events, a perceived unfairness in the queue or a system that buckles under the load can severely damage organizational reputation and make international headlines1. Traditional queuing mechanisms often rely on relational databases or in-memory stores, which struggle under sudden, massive concurrency without introducing complex, fragile distributed locking mechanisms2. Alternatively, standard Amazon DynamoDB queuing models typically utilize an "active promotion" strategy. In such models, each user’s status is individually updated from WAITING to ELIGIBLE as capacity frees up. While logically sound for smaller workloads, this pattern results in a devastating secondary write-stampede; promoting 100,000 users requires 100,000 individual write operations, generating immense costs and triggering catastrophic partition throttling.  
To satisfy the requirement for a truly unique, out-of-the-box architecture, this report introduces the **Zero-Write Passive Promotion** architecture powered by **Time-Density Watermarking**. This paradigm entirely eliminates the need to update individual user records during the promotion phase. Instead, it relies on cryptographic timestamping, deterministic edge-compute tie-breaking, and a centrally shifting global watermark that implicitly promotes massive batches of users with a single database write.

## **Theoretical Foundations: Edge Latency and Consistency**

Designing a system to handle ten million concurrent connections requires reconciling the CAP theorem—specifically balancing consistency and availability in the face of inevitable network partitions3. Recent analyses into the "Edge Latency Lie" highlight why edge computing frequently fails at data writes; achieving distributed consensus for a globally consistent state across geographically dispersed edge nodes introduces unacceptable latency and conflict resolution overhead3.  
Consequently, the architecture must centralize the authoritative state (the queue order and the current admission watermark) within a highly scalable, strongly consistent storage layer—Amazon DynamoDB—while aggressively decentralizing the evaluation of that state to the edge. The virtual waiting room operates as a hybrid stateful-stateless system5. The ingestion and queuing of users require persistent state tracking to guarantee a First-In-First-Out (FIFO) ordering5. However, the verification of a user's status can be handled statelessly at the edge by comparing a cryptographically signed client token against a globally cached, centralized watermark. This bifurcated approach resolves the global consistency problem while maintaining single-digit millisecond latency for the end user.

## **DynamoDB Data Model: Single-Table Design**

To handle the extreme scale of the event, the architecture utilizes a Single-Table Design in Amazon DynamoDB. The table is structured to store queue tickets, the global metadata (including the watermark and time-density map), and active session states (to fulfill the requirement of sustaining exactly 1,000 active users)1.

### **Base Table Configuration**

The foundational configuration of the DynamoDB table dictates its ability to survive the initial burst.

| Configuration Parameter | Selected Value | Architectural Justification |
| :---- | :---- | :---- |
| **Table Name** | VirtualWaitingRoom | Standardized nomenclature for the centralized data store. |
| **Billing Mode** | PAY_PER_REQUEST with Pre-Warming Script | Default PAY_PER_REQUEST avoids account-limit deployment errors. Before the event, a CLI script (scripts/prewarm-table.js) switches to PROVISIONED with high WCUs. After the stampede, it flips back to PAY_PER_REQUEST. |
| **Partition Key (PK)** | PK (String) | A generic partition key allows for entity overloading within the single-table design6. |
| **Sort Key (SK)** | SK (String) | Enables hierarchical sorting, time-series ordering, and sophisticated begins\_with query operations10. |
| **Time to Live (TTL)** | ExpiresAt (Number) | Automatically purges stale queue tickets and abandoned checkout sessions without requiring secondary cleanup logic or background deletion workers1. |

### **Entity Definitions and Key Schema**

The system models three primary entities within the same table. The table below outlines the item structure, the core attributes, and the rationale for the key schemas.

| Entity Type | Partition Key (PK) | Sort Key (SK) | Core Attributes | Rationale |
| :---- | :---- | :---- | :---- | :---- |
| **QueueTicket** | EVENT\#\<EventId\>\#SHARD\#\<ShardId\> | TS\#\<EntryTimestamp\>\#FAN\#\<FanId\> | FanId, EntryTimestamp, ShardId, ExpiresAt | **Write Sharding**: Writes are distributed across 2,000 random shards in PK. The Sort Key embeds the timestamp for chronological ordering within a shard. |
| **GlobalState** | EVENT\#\<EventId\>\#METADATA | METADATA | AdmittedUntilTimestamp, TieBreakerThreshold, ActivePurchaserCount | **Singleton State**: Tracks the global admission watermark. TieBreakerThreshold (0-100) gates partial-second admission. Heavily cached at the edge. |
| **SessionItem** | EVENT\#\<EventId\>\#SESSION\#\<FanId\> | SESSION | FanId, GSIPK, StartedAt, ExpiresAt | **Dynamic Checkout Sessions**: Created on-demand when an admitted user claims a slot. PK is unique per fan (naturally distributed). GSI (SessionMetadataIndex) enables fast session counting for the replenishment loop. |
| **DensityBucket** | EVENT\#\<EventId\>\#DENSITY | BUCKET\#\<Timestamp\> | Count | **Time-Density Map**: Stores per-second arrival counts. Written by the stream aggregator via atomic ADD Count. Read via a single Query. |

## **Ingestion and Write Sharding Strategy (Absorbing the Stampede)**

The primary bottleneck in any high-throughput ingestion system is the physical limitation of the underlying storage hardware. In DynamoDB, data is distributed across multiple physical partitions based on the hash of the Partition Key8. A single DynamoDB partition can sustain a hard limit of 1,000 Write Capacity Units (WCUs) per second and 3,000 Read Capacity Units (RCUs) per second14.  
If ten million fans arrive within a tight 10-second window, the system must process an ingestion rate of 1,000,000 writes per second. If the application utilized a naive partition key such as EVENT\#match2026, all 1,000,000 writes would target a single partition, instantly triggering a ProvisionedThroughputExceededException and dropping fans8.  
To absorb this stampede, the QueueTicket items must be heavily write-sharded1. Write sharding involves appending a random or calculated suffix to the partition key to distribute the collection across a predetermined number of partitions8.  
The ingestion compute nodes (e.g., AWS Lambda or AWS Fargate instances fronted by Amazon API Gateway) execute the following logic:

1. Generate a random integer ShardId between 1 and 2,000.  
2. Construct the Partition Key: EVENT\#match2026\#SHARD\#1452.  
3. Construct the Sort Key using the arrival timestamp: TS\#1719997205124\#FAN\#fan\_12345.  
4. Execute the PutItem request.

Because the incoming requests are uniformly randomized across 2,000 logical partitions, the 1,000,000 writes/second load is distributed evenly. This mathematical distribution results in roughly 500 writes per second, per partition. This volume sits comfortably below the 1,000 WCU limit per partition, entirely eliminating throttling constraints and ensuring no fans are dropped or misordered during the initial burst8.

## **Fair Queue Position Assignment and Clock Skew Mitigation**

A foundational requirement of a virtual waiting room is the perception and reality of absolute fairness1. Ensuring this fairness requires pristine timestamping and a mechanism to prevent malicious actors from gaming their queue position. In distributed systems, this is notoriously difficult due to clock skew—the phenomenon where different physical machines record slightly different times due to oscillator drift18.  
If the clock on Application Server A is 500 milliseconds behind the clock on Application Server B, a fan hitting Server B could be unfairly penalized, violating the strict FIFO requirement5. Traditional synchronization protocols like the Network Time Protocol (NTP) often suffer from asymmetric network delays, leading to unpredictable clock synchronization19.

### **Timestamps for Entry Ordering**

When a fan arrives, the ingestion Lambda records the arrival timestamp using `Date.now()` (millisecond precision from the system clock). Lambda execution environments run on AWS Nitro instances where system clock drift is minimal and bounded by the hypervisor, making external time sync services unnecessary. The entry timestamp is embedded in the JWT payload and cryptographically signed, preventing client-side tampering.

Tie-breaking at second granularity uses a deterministic hash of the fan ID, ensuring fairness for users who arrive within the same second. This avoids the complexity of microsecond-level synchronization while maintaining FIFO ordering at second boundaries.

### **Preventing Queue-Position Gaming via Cryptographic JWTs**

If the system merely told the client browser its entry timestamp, sophisticated users could modify their local state to claim an earlier arrival time. To prevent queue-position gaming, the system utilizes cryptographic attestation21.  
Upon successfully writing the QueueTicket to DynamoDB, the ingestion API generates a JSON Web Token (JWT)21. The payload of this JWT contains the user's FanId and their authoritative EntryTimestamp. The token is signed using a secure backend secret (e.g., an HMAC SHA-256 signature or an asymmetric RSA key stored in AWS Key Management Service).  
The fan *must* present this signed JWT to poll their status and to enter the purchasing flow. Because the timestamp is immutably embedded within the cryptographic signature, the fan cannot manipulate their browser payload. Any tampering instantly invalidates the signature, and the request is dropped by the API Gateway custom authorizer.

### **Managing Near-Simultaneous Arrivals at Scale**

At an ingestion rate of 1,000,000 arrivals per second, up to 100,000 fans may arrive within the same 1-second wall-clock bucket. Promoting all of them at once would instantly overflow the 1,000-slot checkout capacity.

The system uses **Deterministic Hash-Based Tie-Breaking** to gate partial-second admission:

1. The Promotion Engine calculates how many users from the current second bucket can be admitted (freeSlots).
2. It sets `TieBreakerThreshold = ceil((toAdmit / bucket.count) * 100)` as an integer 1-99 on GlobalState.
3. When a fan polls status or claims a slot, the verifier computes: `Math.abs(hashCode(fanId)) % 100 < TieBreakerThreshold`.
4. Only fans passing the threshold are eligible. This distributes admission fairly across the entire cohort without additional database writes.

The hash function is deterministic (Java-style string hash), so each fan gets a consistent result across requests. No coordination or locking is needed.

## **The Zero-Write Batch Promotion Strategy (Time-Density Watermarking)**

The most resource-intensive phase of a standard virtual waiting room involves progressively promoting batches of fans from "waiting" to "eligible to browse" based on their position and available purchasing capacity1. A traditional queue architecture queries the database for the oldest ![][image1] tickets and executes ![][image1] sequential UpdateItem requests to change a Status field from WAITING to ELIGIBLE. For millions of users, this generates continuous, massive write spikes, leading to exorbitant DynamoDB costs and the risk of hot partitions.  
The proposed **Time-Density Watermarking** paradigm eliminates this requirement entirely, moving from an ![][image2] write complexity to an ![][image3] write complexity22.

### **1\. Building the Time-Density Map via DynamoDB Streams**

As fans enter the system and their QueueTicket items are written to the sharded partitions, a DynamoDB Stream captures the insert events. This stream triggers an asynchronous Aggregator Lambda.

The Aggregator reads micro-batches of stream records, accumulates per-second arrival counts in memory, and flushes via atomic `ADD Count :inc` on individual **DensityBucket** items:

```
PK = EVENT#match2026#DENSITY
SK = BUCKET#1719997200
Count = 15000
```

Using individual items instead of a JSON map on GlobalState allows safe concurrent writes from multiple aggregator instances without read-modify-write races. With at most 3600 items per event, a single Query retrieves the full density map efficiently.

### **2\. Shifting the Watermark (Passive Promotion)**

The core innovation lies in how promotion is triggered. When the downstream purchasing system signals that capacity has freed up (e.g., 5,000 available seats), the centralized Promotion Engine Lambda examines the TimeDensityMap. It calculates exactly how far forward in time the admission window must advance to encompass exactly 5,000 fans.  
Once the target timestamp is calculated, the Promotion Engine executes a *single* DynamoDB UpdateItem on the GlobalState item, shifting the watermark forward:

SQL  
UPDATE VirtualWaitingRoom   
SET AdmittedUntilTimestamp \= 1719997201150   
WHERE PK \= 'EVENT\#match2026\#METADATA'

### **3\. Edge-Evaluated Eligibility**

Fans polling their status do not query their own DynamoDB row to check if they have been promoted. Instead, their client application calls a heavily cached endpoint that returns the GlobalState item containing the updated AdmittedUntilTimestamp.  
The client-side logic, backed by a secure API Gateway authorizer protecting the actual checkout flow, simply compares the fan's cryptographically signed JWT EntryTimestamp against the global AdmittedUntilTimestamp.

* If Fan.EntryTimestamp \<= Global.AdmittedUntilTimestamp: The fan is promoted to "Eligible to Browse."  
* If Fan.EntryTimestamp \> Global.AdmittedUntilTimestamp: The fan remains in the waiting room.

By shifting the computational burden of state evaluation to the edge and the client, the architecture ensures that promoting 100,000 fans requires exactly **one** write operation instead of 100,000. This represents a 99.999% reduction in promotion-phase DynamoDB write capacity costs.

## **Fan Status Query Design: Surviving Millions of Polling Requests**

While millions of fans sit in the virtual waiting room, their browsers must periodically poll the system for real-time status updates, estimated wait times, and queue positions1. If 10 million fans poll every 10 seconds, the system faces an onslaught of 1,000,000 Read Capacity Units (RCUs) per second. Permitting direct reads against DynamoDB at this volume would be prohibitively expensive and highly prone to partition exhaustion.

### **The Heavily Cached Edge Approach**

Because the system utilizes Passive Promotion via a global watermark, the only data required by the millions of polling clients is the GlobalState item12. This allows for an extraordinarily efficient caching strategy.

1. **Amazon CloudFront Integration**: The polling endpoint (e.g., GET /api/v1/event/{id}/status) is fronted by Amazon CloudFront with a strict caching Time-To-Live (TTL) of 1 to 5 seconds.  
2. **Cache Collapse**: The massive concurrency of 1,000,000 requests per second collapses into a single origin fetch per CloudFront edge location, per second. The origin Lambda fetches the GlobalState item from DynamoDB, costing only 1 RCU per origin request, effectively insulating the database from the read stampede.

### **Queue Position and Estimated Wait Time (EWT) Calculation**

Queue position and EWT are computed server-side by the status polling Lambda using the density map.  
Queue position is the sum of all density bucket counts whose timestamp is earlier than the user's EntryTimestamp.  
EWT is estimated as `queuePosition / max(activePurchaserCount * completionRateFactor, 1)`, where `completionRateFactor` defaults to 0.01 (configurable via `COMPLETION_RATE_FACTOR` environment variable). This assumes each active purchaser completes at a steady rate proportional to the number of active sessions.

Because the cached GlobalState (2s TTL at the edge) contains the density map, ActivePurchaserCount, and watermark, the status Lambda can serve millions of polling requests with fewer than 10 DynamoDB reads per second.

## **Dynamic Capacity Regulation: The 1,000 Active User Stretch Goal**

The system continuously draws new batches of users from the waiting room to keep exactly 1,000 active checkout sessions, without waiting for all slots to empty.

### **Dynamic Session Creation with TransactWriteItems**

When an admitted fan calls `POST /claim`, the Slot Handler:

1. Reads `AdmittedUntilTimestamp` and `TieBreakerThreshold` from GlobalState to verify admission eligibility.
2. Executes a single `TransactWriteItems` containing:
   - **Put**: Creates a `SessionItem` (`PK = EVENT#<id>#SESSION#<fanId>`, `SK = SESSION`) with a 5-minute TTL.
   - **Update**: Increments `ActivePurchaserCount` on GlobalState, conditioned on `ActivePurchaserCount < 1000`.

If the counter is at capacity, the transaction fails atomically — no session is created, no rollback needed. If the fan is not yet admitted (timestamp beyond watermark or tie-breaker filter), a 403 is returned.

### **The Replenishment Feedback Loop — GSI-Based Counting**

The Promotion Engine (runs continuously via EventBridge schedule + 58s internal loop) does not rely on TTL stream events or counter reads for replenishment. Instead it:

1. **Queries** the `SessionMetadataIndex` GSI with `GSIPK = EVENT#<id>#SESSION_META AND ExpiresAt > :now`, using the sort key on ExpiresAt to filter expired sessions at the DB level.
2. **Counts** results via `Select: COUNT` to get the real active session count.
3. Calculates `freeSlots = 1000 - validCount`, then advances the watermark to admit the next batch of users (using tie-breaking for partial-second precision).

The sort key on ExpiresAt means expired sessions are excluded by DynamoDB itself, so no post-query filtering or pagination is needed. Sessions are capped at 1000, so the query always fits in one page.

Expired sessions are cleaned up asynchronously by DynamoDB TTL (no immediate deletion needed). The TTL default delay (up to 48h) is acceptable because the promotion engine continuously recomputes the real count from the GSI every second.

A separate Reconciliation Lambda runs every 5 minutes using the same GSI-based counting to correct any counter drift.

## **Access Pattern Matrix**

A well-architected DynamoDB solution must define its access patterns prior to deployment, ensuring that all operations utilize highly efficient Query or PutItem commands rather than expensive full-table Scans15. The following matrix details the fundamental access patterns that serve the Zero-Write Passive Promotion architecture.

| Access Pattern | Target | Key Condition | Condition Expression | Architectural Function |
| :---- | :---- | :---- | :---- | :---- |
| **1\. Ingest Fan (Stampede)** | Table | N/A (PutItem) | attribute\_not\_exists(PK) | PK \= EVENT\#\<Id\>\#SHARD\#\<Random\>, SK \= TS\#\<Time\>\#FAN\#\<FanId\>. Distributes write load across 2,000 random shards. |
| **2\. Aggregator Stream Read** | DDB Stream | N/A | N/A | Captures QueueTicket INSERT events for density aggregation. |
| **3\. Retrieve Global State** | Table | PK = EVENT\#\<Id\>\#METADATA, SK = METADATA | None | Point-read for watermark and tie-breaker threshold. Heavily cached at edge via CloudFront. |
| **4\. Advance Watermark** | Table | PK = EVENT\#\<Id\>\#METADATA, SK = METADATA | AdmittedUntilTimestamp < :newWatermark | Single UpdateItem to shift the admission watermark (passive promotion). |
| **5\. Count Active Sessions (Replenishment + Reconciliation)** | GSI | GSIPK = EVENT\#\<Id\>\#SESSION\_META AND ExpiresAt \> :now | None | Query the `SessionMetadataIndex` with sort key on ExpiresAt. `Select COUNT` returns only non-expired sessions filtered at the DB level. No post-query filtering needed. |
| **6\. Claim Checkout Slot** | Table (TransactWriteItems) | N/A | attribute\_not\_exists(PK) AND ActivePurchaserCount < 1000 | Atomic transaction: creates SessionItem + increments counter. Fails atomically if counter at 1000. |
| **7\. Release Checkout Slot** | Table | PK = EVENT\#\<Id\>\#SESSION\#\<FanId\>, SK = SESSION | attribute\_exists(PK) | Conditional DeleteItem (to prevent double-release), then decrement counter. |
| **8\. Get Density Map** | Table | PK = EVENT\#\<Id\>\#DENSITY, SK begins\_with BUCKET\# | None | Single Query (not 20 parallel) to retrieve all per-second density buckets. |

## **Design Rationale and Trade-off Analysis**

To comprehensively address the evaluation criteria for the design rationale, it is vital to articulate the trade-offs inherent in this specific architecture, acknowledging that every distributed system choice requires sacrificing one attribute to optimize another15.  
**Write Sharding vs. Read Complexity** The implementation of a randomized ShardId in the partition key is non-negotiable for absorbing the 1,000,000 writes/second burst, as it prevents hot partitions1. The primary trade-off of write sharding is that it drastically increases the complexity of reading the data; to view the entire queue, the application must perform a "scatter-gather" query across all 2,000 shards11. However, in the Zero-Write Passive Promotion model, the application explicitly *does not need* to query the shards. The queue is advanced via the global watermark, rendering the scatter-gather read penalty irrelevant to the critical path.  
**Passive Promotion vs. Active State Management** Traditional active promotion provides strong consistency at the individual user level; a user's database record unambiguously states their status. Passive promotion trades this database-level state for computational evaluation at the edge. The trade-off is that client applications and API Gateways must be trusted to enforce the rules by comparing the cryptographic JWT against the watermark. While this introduces slightly more complexity into the API authorization layer, the cost savings and elimination of write-throttling during mass promotions make this a necessary sacrifice for extreme-scale events.  
**Estimated Queue Positions vs. Absolute Precision** Calculating absolute queue position requires constantly counting items in the database, generating prohibitive read costs. Relying on the TimeDensityMap provides an *estimated* queue position. The trade-off is a slight loss of pinpoint accuracy (a user might see their position jump by batches of 10 rather than decrementing by exactly 1). However, as noted in architectural reviews of high-scale systems, estimated queue positions significantly reduce read traffic while still providing a highly acceptable user experience1.

## **NoSQL Workbench Data Model Definition**

To fulfill the deliverable requirements, the logical schema has been modeled and exported using AWS NoSQL Workbench1. The JSON structure below defines the single-table design exported from AWS NoSQL Workbench. The model includes the `SessionMetadataIndex` GSI with `INCLUDE` projection, and representative sample data across all entity types.

The data model is available in the repo at `data-model/virtual-waiting-room.json` for direct import into NoSQL Workbench.

The TableAttributes define the strong typings expected by the DynamoDB API, explicitly utilizing the S (String) and N (Number) type descriptors. The TableData array provides the visualizer with the exact items needed to simulate the stampede ingestion, the global watermark representation, and the active slot management required for the stretch goal12.

## **Strategic Implementation Roadmap**

Transitioning this theoretical architecture into a functional prototype for the AWS Builder Center challenge requires a disciplined, phase-gated engineering approach. The following roadmap guarantees that all judging criteria—completeness, data model correctness, scalability, and cost—are systematically addressed.

### **Phase 1: Local Modeling and Verification**

The initial phase focuses entirely on data model correctness. Engineers must import the provided JSON structure into the local instance of AWS NoSQL Workbench29. Utilizing the Operation Builder, synthetic PutItem requests must be simulated to verify that the random ShardId generation effectively scatters the load15. The single UpdateItem operation representing the watermark progression must be tested to ensure it updates atomically without disrupting concurrent read operations.

### **Phase 2: Infrastructure as Code (IaC) Deployment**

Deploying a system meant for 10 million concurrent connections requires strict reliance on Infrastructure as Code, utilizing AWS Serverless Application Model (SAM) or the AWS Cloud Development Kit (CDK). The VirtualWaitingRoom DynamoDB table must be provisioned with high initial Write Capacity Units (WCUs) to survive the simulated stampede, avoiding the cold-start limitations of On-Demand billing mode8.  
The ingestion tier requires deploying an Amazon API Gateway HTTP API integrated with an AWS Lambda function. The Lambda assigns the EntryTimestamp via Date.now() (Nitro system clock bounded to sub-millisecond drift). A cryptographic signing library (jose) is integrated into this Lambda to generate the anti-gaming JWT. An Amazon CloudFront distribution is deployed with strict cache policies to absorb the polling queries31.

### **Phase 3: Aggregation and Promotion Engine Implementation**

The asynchronous processing tier introduces the complex logic of the Time-Density Watermark. DynamoDB Streams must be enabled on the table, routing to an Aggregator Lambda function24. This function requires robust error handling and partial batch response capabilities to process the stream of new QueueTicket inserts, bin them by timestamp, and update the TimeDensityMap.  
Simultaneously, the active user stretch goal requires implementing the Capacity Monitor Lambda. An Amazon EventBridge schedule will invoke this function every second to query the ACTIVE\_SLOTS partition, identify the deficit from 1,000, and shift the AdmittedUntilTimestamp watermark accordingly to trigger the passive promotion of the next batch of users.

### **Phase 4: Load Testing, Refinement, and Submission**

The final phase validates the scalability and cost judging criteria. Utilizing AWS Distributed Load Testing (DLT), a synthetic stampede of millions of connections must be directed at the API. The system must be monitored via Amazon CloudWatch to verify that no ProvisionedThroughputExceededException errors occur during ingestion and that the CloudFront cache hit ratio remains above 99.9%, insulating DynamoDB from read exhaustion.  
The cryptographic validation must be tested by attempting to submit forged JWTs to the simulated checkout API, verifying that the authorizer correctly rejects tokens bearing an EntryTimestamp newer than the global AdmittedUntilTimestamp. Upon successful validation, the final NoSQL Workbench .json model, the comprehensive design document, and the IaC repositories must be committed to a public GitHub repository and submitted to the AWS Builder Center15.

## **Conclusion**

The challenge of fairly queuing up to 10 million concurrent fans within seconds dictates a total departure from conventional, row-locking queue patterns. Standard active-promotion queues crumble under the load of massive secondary write spikes. The architecture detailed in this report resolves the initial "stampede" problem through mathematically sound, aggressive write sharding, effectively turning 1,000,000 writes per second into manageable, evenly distributed streams across thousands of logical partitions8.  
More importantly, by introducing the **Zero-Write Passive Promotion** model via Time-Density Watermarking, the system entirely bypasses the fundamental bottleneck of traditional DynamoDB queuing. It delegates the computationally heavy lifting of eligibility verification to highly scalable CloudFront edge caches and client-side deterministic logic. Combined with JWT-signed entry timestamps to guarantee chronological fairness and prevent gaming, along with an active slot monitoring loop to sustain exact purchasing throughput, this design provides a uniquely robust and cost-effective solution. It is an architecture capable of surviving the most extreme ticketing traffic loads imaginable without buckling, ensuring fairness, maintaining order, and preserving the integrity of the downstream systems.

#### **Works cited**

1. The Virtual Waiting Room \- Fairly Queuing 1 Million Fans Under Extreme Load, [https://builder.aws.com/content/3FbJLetP1QgDYVWeAKsomJZATiy/the-virtual-waiting-room-fairly-queuing-1-million-fans-under-extreme-load](https://builder.aws.com/content/3FbJLetP1QgDYVWeAKsomJZATiy/the-virtual-waiting-room-fairly-queuing-1-million-fans-under-extreme-load)  
2. Part 3: Seat Management \- DEV Community, [https://dev.to/sumedhbala/part-3-seat-management-nn2](https://dev.to/sumedhbala/part-3-seat-management-nn2)  
3. AWS Builder Center \- Amazon.com, [https://aws.amazon.com/developer/?nc1=f\_dr\&sc\_channel=sm\&sc\_campaign=AWSomeDays\_APAC\&sc\_publisher=LINKEDIN\&sc\_country=Global%2CGlobal+%28Public+Sector+Users%29%2CGlobal+%28EMEA+users%29%2CGlobal+%28APAC+users%29%2CGlobal+%28LATAM+users%29\&sc\_geo=APAC\&sc\_outcome=event\_registration\&trkCampaign=awsome-day-online\&trk=sm\_post1AWSomeday\_LINKEDIN](https://aws.amazon.com/developer/?nc1=f_dr&sc_channel=sm&sc_campaign=AWSomeDays_APAC&sc_publisher=LINKEDIN&sc_country=Global,Global+\(Public+Sector+Users\),Global+\(EMEA+users\),Global+\(APAC+users\),Global+\(LATAM+users\)&sc_geo=APAC&sc_outcome=event_registration&trkCampaign=awsome-day-online&trk=sm_post1AWSomeday_LINKEDIN)  
4. One year. One community. Built together. \- AWS Builder Center, [https://builder.aws.com/?trk=73d03a36-6382-40a4-88b8-0201beadad1e](https://builder.aws.com/?trk=73d03a36-6382-40a4-88b8-0201beadad1e)  
5. How SeatGeek Successfully Handle High Demand Ticket On-Sales \- QCon London, [https://archive.qconlondon.com/system/files/presentation-slides/qcon\_london\_seatgeek.pdf](https://archive.qconlondon.com/system/files/presentation-slides/qcon_london_seatgeek.pdf)  
6. Modeling a service using the single table design in DynamoDB | by Luan Figueredo, [https://medium.com/@luanrubensf/modeling-a-service-using-the-single-table-design-in-dynamodb-631e459fd06e](https://medium.com/@luanrubensf/modeling-a-service-using-the-single-table-design-in-dynamodb-631e459fd06e)  
7. Mastering the Art of Single Table Design in DynamoDB: REST API Example Provided, [https://blog.stackademic.com/mastering-the-art-of-single-table-design-in-dynamodb-rest-api-example-provided-e39c005e80a8](https://blog.stackademic.com/mastering-the-art-of-single-table-design-in-dynamodb-rest-api-example-provided-e39c005e80a8)  
8. Choosing the right number of shards for your large-scale Amazon DynamoDB table \- AWS, [https://aws.amazon.com/blogs/database/choosing-the-right-number-of-shards-for-your-large-scale-amazon-dynamodb-table/](https://aws.amazon.com/blogs/database/choosing-the-right-number-of-shards-for-your-large-scale-amazon-dynamodb-table/)  
9. Import and export CloudFormation templates and CSV sample data with NoSQL Workbench for Amazon DynamoDB | AWS Database Blog, [https://aws.amazon.com/blogs/database/import-and-export-cloudformation-templates-and-csv-sample-data-with-nosql-workbench-for-amazon-dynamodb/](https://aws.amazon.com/blogs/database/import-and-export-cloudformation-templates-and-csv-sample-data-with-nosql-workbench-for-amazon-dynamodb/)  
10. amazon-dynamodb-design-patterns/examples/an-online-shop/README.md at master \- GitHub, [https://github.com/aws-samples/amazon-dynamodb-design-patterns/blob/master/examples/an-online-shop/README.md](https://github.com/aws-samples/amazon-dynamodb-design-patterns/blob/master/examples/an-online-shop/README.md)  
11. Leaderboard & Write Sharding | DynamoDB, explained., [https://www.dynamodbguide.com/leaderboard-write-sharding/](https://www.dynamodbguide.com/leaderboard-write-sharding/)  
12. [unknown\_url](http://docs.google.com/unknown_url)  
13. Implement resource counters with Amazon DynamoDB | AWS Database Blog, [https://aws.amazon.com/blogs/database/implement-resource-counters-with-amazon-dynamodb/](https://aws.amazon.com/blogs/database/implement-resource-counters-with-amazon-dynamodb/)  
14. Everything you need to know about DynamoDB Partitions | DeBrie Advisory, [https://alexdebrie.com/posts/dynamodb-partitions/](https://alexdebrie.com/posts/dynamodb-partitions/)  
15. DynamoDB Football Data Modeling Challenges \- Terms and Conditions, [https://builder.aws.com/content/3FbH5Z16W1FqzthKX6uy705Kdlt](https://builder.aws.com/content/3FbH5Z16W1FqzthKX6uy705Kdlt)  
16. Exercise 3: Global Secondary Index Write Sharding \- Amazon DynamoDB Immersion Day, [https://000039.awsstudygroup.com/3-ladv/3.4/](https://000039.awsstudygroup.com/3-ladv/3.4/)  
17. How to query a DynamoDB global secondary index across multiple shards?, [https://stackoverflow.com/questions/54043954/how-to-query-a-dynamodb-global-secondary-index-across-multiple-shards](https://stackoverflow.com/questions/54043954/how-to-query-a-dynamodb-global-secondary-index-across-multiple-shards)  
18. Clock Synchronization Is a Nightmare \- Arpit Bhayani, [https://arpitbhayani.me/blogs/clock-sync-nightmare/](https://arpitbhayani.me/blogs/clock-sync-nightmare/)  
19. Achieving Precise Clock Synchronization on AWS \- Yugabyte, [https://www.yugabyte.com/blog/aws-clock-synchronization/](https://www.yugabyte.com/blog/aws-clock-synchronization/)  
20. Aurora DSQL: How the Latest Distributed SQL Database Compares to YugabyteDB, [https://www.yugabyte.com/blog/aurora-dsql-compared-to-yugabytedb/](https://www.yugabyte.com/blog/aurora-dsql-compared-to-yugabytedb/)  
21. virtual-waiting-room-on-aws/docs/developer-guide.md at main \- GitHub, [https://github.com/aws-solutions/virtual-waiting-room-on-aws/blob/main/docs/developer-guide.md](https://github.com/aws-solutions/virtual-waiting-room-on-aws/blob/main/docs/developer-guide.md)  
22. AWS DynamoDB Watermark Backend | Signatory \- A Tezos Remote Signer, [https://signatory.io/docs/aws\_dynamodb/](https://signatory.io/docs/aws_dynamodb/)  
23. Fixing Queues with Watermarks \- Forrest Shares Stuff, [https://forrestmcdaniel.com/2021/06/30/fixing-queues-with-watermarks/](https://forrestmcdaniel.com/2021/06/30/fixing-queues-with-watermarks/)  
24. Amazon DynamoDB – AWS Database Blog, [https://aws.amazon.com/blogs/database/tag/amazon-dynamodb/feed/](https://aws.amazon.com/blogs/database/tag/amazon-dynamodb/feed/)  
25. Use atomic counter operations in DynamoDB with an AWS SDK, [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/example\_dynamodb\_Scenario\_AtomicCounterOperations\_section.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/example_dynamodb_Scenario_AtomicCounterOperations_section.html)  
26. Exporting a data model \- Amazon DynamoDB \- AWS Documentation, [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/workbench.Modeler.ExportModel.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/workbench.Modeler.ExportModel.html)  
27. How to get the DynamoDB data model from NoSQL Workbench based on Dynamose Schema? \- Stack Overflow, [https://stackoverflow.com/questions/78045118/how-to-get-the-dynamodb-data-model-from-nosql-workbench-based-on-dynamose-schema](https://stackoverflow.com/questions/78045118/how-to-get-the-dynamodb-data-model-from-nosql-workbench-based-on-dynamose-schema)  
28. Visualize data models with NoSQL Workbench \- Amazon Keyspaces (for Apache Cassandra) \- AWS Documentation, [https://docs.aws.amazon.com/keyspaces/latest/devguide/workbench.vizualizer.html](https://docs.aws.amazon.com/keyspaces/latest/devguide/workbench.vizualizer.html)  
29. DynamoDB Data Modeler, [https://rh-web-bucket.s3.amazonaws.com/index.html](https://rh-web-bucket.s3.amazonaws.com/index.html)  
30. Sample data models for NoSQL Workbench \- Amazon DynamoDB, [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/workbench.SampleModels.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/workbench.SampleModels.html)  
31. Introducing AWS Virtual Waiting Room | AWS Compute Blog, [https://aws.amazon.com/blogs/compute/introducing-aws-virtual-waiting-room/](https://aws.amazon.com/blogs/compute/introducing-aws-virtual-waiting-room/)  
32. AWS Virtual Waiting Room \- awsstatic.com, [https://d1.awsstatic.com/architecture-diagrams/ArchitectureDiagrams/aws-virtual-waiting-room-sol.pdf?did=wp\_card\&trk=wp\_card](https://d1.awsstatic.com/architecture-diagrams/ArchitectureDiagrams/aws-virtual-waiting-room-sol.pdf?did=wp_card&trk=wp_card)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAaCAYAAABVX2cEAAABA0lEQVR4Xu2SvQ4BQRSFr4RCIaJSKyV+CpVH0IkoJB5Ao/IEngGFaCQajVIQErVolHrRqxXCOWYndmbXbqGT/ZIvkT039841IxLxKzV4gBfHkhm/WcCJpS9F2IRj+IRzGDcqRNpwDx9wCOtm7GUA1/AGC1ZGOnAEY3Zgk4crmBF1ujPMunJ+Z866ULgGT0auohq2PrFU4E5U01DYiA0JV2GzDUw639zDArFXqMK7I3+TqXyGBeI3lSvydFw5B5cwZVR8wb2ihn8+L4ENu+Id5gtX3MKyHYC+qGZH2DAjf9xPwobr6ZsNfRIJeIIzmLYyjb6MQHQRp2p7RoWCT4Mnj4j4H15INzZPvLrhKQAAAABJRU5ErkJggg==>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAaCAYAAAAaAmTUAAAC2ElEQVR4Xu2XS8iNQRjHH6HI/ZJL2ZAFsSBZuCw+RZFQbBQb2cpCISV9G3u3JJEs5LKRXBZYyIaydVlZkJIkK3Ln/2vO0zdnzsz7ns5l5fzq3znnmfebeZ+Z/zMzn9mA/4cp0tg02AU9649OZktzpYlJW4590mnr0eANdkg3LSTVEaOkJ9JX6a30TvolrYkfyvBMmpUGxVTprPS6oWPWnPA46ZR0UTrf0MFGnHc5JD2wDhKaJ92Stkmjo/h06beFmcqxUNqQBhtMkDZLe6S/0ndpVdQ+RhqykORzaa+02kIiMEN6aiEpj9WyzMJKMMM5GOiztDyJM8AJaXwST1ksvbSQ0BlrfbGZ0tIk5uyUPkhL0oYcjy0MsjttiNhi4RmSnRbFqZX30e8SWIkafGWhH/4uZlfyO4bEmYAXaUMOOmcpq3zpybyxsCkAvr4rPfSHCpD8vcb3YRsZz+FlL0W/c5DszzSYMt/yM5VywFqT4ZPfF/yhAljMk8FK2PXPSHNTsiVWWtiUKiFjOi/51WHmUputkL5Ih/2hAoyBzYCCv2qhL74D/bBjVbHAauzM+fFIumKtBZnCTPICW6OYW4/PEj7rrI6DnbHZsI1YbHvUnsNdgLWzeDKXk3gKA+bqqp1k3GLxpgHYms1gkbUmm8OTKR7gXsB1yWADzpn0LGknGSyWqymv1ZPSHWlSc3MLnkylg45bSKi0fMzEfcsfWmst7DBsDiWoldK2SzLI66kKT6YSt9A1C6e1M9nCin2T9kfxGA469n5qLoWT+4j0UVpnzTcKh43gk9VbDNZbcEct+Jdtj8xZqevSD+mGBTuU8OJNDzNe3Gfdxb0sZaOFVS/WQQQ7ZuVuFoPNhixYgs92BgB2N+5b/cRrm5XsK9yUubf1E85A7masZN/hTldlx27Aylxkb1v9ZbZn4P3SvwidwpmGvXrdby1zpHMW/ifqFUelTWlwwIAB3fMPhAKSIc/E5zMAAAAASUVORK5CYII=>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAaCAYAAAAue6XIAAACPUlEQVR4Xu2WP2iUQRDFn6igaBSDRANCUGxEC4NiEwk2AZuYwlK7FLEQCwvtFXtBCwtBLIQY0ogIQSyMFgnYapMuItgpFpH43/ecW1jmdvf2Er6AcD94fNzMZnd2d3YyQI//h93UVm8ssI3a6Y1rQYvuowZRN+Fl6g66C3aImqdOekctm6gF6iv1nvpA/aRG4kEJ3lAD3hjR7w0tTlFLrW9XHKCeUBPU5siuhX5R5yNbzGFqzBtb7KAmqS/e0UKHc5N6AUujKo7DTlInlOIt9ZkadnYtdpva7uziE2yTupk/zhdzELb2Je9I8Qo22UXviBiHjdFm9kR25erH6HeKhygHK85S370xhSZaRPkaQrDLsEcn9Jqfwa6wRE2wh9B50/+uQBPphEpcRXuw+ur3/TAoQ02wfdRr2AFkuQDLxWPe4XiA9jQ4Qa1Q18OgDDXBbqFmqb3eEVD9fEk9gj2UEr9hC56LbCE19C1RE6zQuCPeGAjBalAJbSSV100Eq9tKEh5Ip2A1gUqQr6VNBKtan+UWLOBcYuv0n1PX0J4qp6kfsMdXoptgw+NNEq54GvbfJrAL9ser1JXIHqPH8A6W8zk051PYGrkDEWGujqhsqRdYhp30Y1iBnoGVthzaqKpEbhEFmFIqbUJlqUK7PgMrZfrWdFpC1eGbN66BKVjT1CjqtNQ3rAf1FXPUXe9oAvUUpXTphKqMGpmj3tEUqhi5FjKHcl5V5h66a9rXzX7YosU66RilbmCDA+3RYyP4CwYsdzUYnQr7AAAAAElFTkSuQmCC>