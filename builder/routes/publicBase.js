/**
 * The address a request came in on — where a load-test simulation sends
 * its turns (task #902), so it runs against the server it was started on.
 * Cloud Run terminates TLS in front of us, so the scheme comes from
 * X-Forwarded-Proto.
 */
function publicBaseOf(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${proto}://${host}` : null;
}

module.exports = { publicBaseOf };
