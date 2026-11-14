/** The store package: every statement and the schema, behind core's Store port. */
export { openEmbeddedStore, type EmbeddedStore } from "./embedded.ts";
export { openServerStore, serverStoreName, StoreUnavailableError } from "./server-postgres.ts";
export { backupEmbeddedStore, restoreEmbeddedStore } from "./backup.ts";
export { BACKUPS_DIR, holdsEmbeddedStore, StoreInUseError, writeSnapshot } from "./data-dir.ts";
