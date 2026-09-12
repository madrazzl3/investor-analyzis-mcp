import { httpRouter } from 'convex/server';
import { auth } from './auth';
import { exchange, jwks } from './mcpBridge';
const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ path: '/mcp/exchange', method: 'POST', handler: exchange });
http.route({ path: '/mcp/jwks', method: 'GET', handler: jwks });
export default http;
