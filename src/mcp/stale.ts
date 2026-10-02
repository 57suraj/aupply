/**
 * What Claude is told when its chat holds an out-of-date copy of Aupply's tools and
 * instructions (an unknown tool name, or a start_session `tv` that is not this deploy's).
 */

export const STALE_ADVICE =
  "Stop here and tell the user: reconnect the Aupply connector (Claude settings, Connectors, Aupply: disconnect, then connect again) and start a new chat. " +
  "Until then do not apply to jobs or click through job boards by hand.";
