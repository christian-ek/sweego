import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const crons = cronJobs();

crons.interval(
  "Clean up old Sweego messages",
  { hours: 1 },
  internal.crons.cleanupSweego,
);

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const cleanupSweego = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, components.sweego.lib.cleanupOldMessages, {
      olderThan: ONE_WEEK_MS,
    });
    // Abandoned (never-finalized) messages usually indicate a bug, so keep
    // them around a bit longer for debugging.
    await ctx.scheduler.runAfter(
      0,
      components.sweego.lib.cleanupAbandonedMessages,
      { olderThan: 4 * ONE_WEEK_MS },
    );
    // Reclaim audit-only events (e.g. unmatched swg_uid) with no parent message.
    await ctx.scheduler.runAfter(0, components.sweego.lib.cleanupOldEvents, {
      olderThan: ONE_WEEK_MS,
    });
  },
});

export default crons;
