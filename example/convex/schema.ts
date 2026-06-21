import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Demo table: a label for each message we send, so the onEvent handler has
  // something in the host app to correlate delivery events against.
  sentMessages: defineTable({
    messageId: v.string(),
    label: v.string(),
    lastEvent: v.optional(v.string()),
  }).index("by_messageId", ["messageId"]),
});
