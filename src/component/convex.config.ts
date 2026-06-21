import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

const component = defineComponent("sweego");

// Durable, retried delivery of sends to the Sweego API. Throughput is bounded
// by the pool's maxParallelism; HTTP 429s are retried with backoff.
component.use(workpool, { name: "sendWorkpool" });
// A separate pool runs your `onEvent` callbacks so they never starve sends.
component.use(workpool, { name: "callbackWorkpool" });

export default component;
