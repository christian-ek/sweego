import { defineApp } from "convex/server";
import sweego from "@christian-ek/sweego/convex.config";

const app = defineApp();
app.use(sweego);

export default app;
