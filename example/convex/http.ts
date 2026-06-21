import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { sweego } from "./example";

const http = httpRouter();

// Sweego will POST delivery events here. The component verifies the HMAC
// signature before processing. With deployment happy-leopard-123 this is:
//   https://happy-leopard-123.convex.site/webhooks/sweego
http.route({
  path: "/webhooks/sweego",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    return await sweego.handleSweegoWebhook(ctx, req);
  }),
});

export default http;
