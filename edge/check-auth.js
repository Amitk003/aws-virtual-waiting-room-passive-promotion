function handler(event) {
  var request = event.request;
  var headers = request.headers;
  var uri = request.uri;

  // Allow join and status requests without authentication
  if (uri.indexOf('/join') !== -1 || uri.indexOf('/status') !== -1) {
    return request;
  }

  // Check Authorization header
  var auth = headers['authorization'];
  if (!auth || typeof auth.value !== 'string' || auth.value.indexOf('Bearer ') !== 0) {
    return {
      statusCode: 401,
      statusDescription: 'Unauthorized',
      headers: {
        'content-type': { value: 'application/json' },
        'access-control-allow-origin': { value: '*' },
      },
      body: '{"error":"Missing or invalid Authorization header"}',
      bodyEncoding: 'text',
    };
  }

  return request;
}
