// The panel owner's name: the author of notes and messages written from the panel and the
// default `--by`. Set NIGHTLY_OWNER (in .env) to your own name; the default is neutral.
import './env.mjs'
export const OWNER = (process.env.NIGHTLY_OWNER || 'owner').trim() || 'owner'
