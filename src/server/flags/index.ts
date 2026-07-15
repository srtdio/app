// Feature-flag read/write/eval module (Phase 1 backend).
//
// Public surface:
//   - evalFlag:  resolve + evaluate one flag for a principal.
//   - setFlag:   create/update a flag row (service-role) and audit it.
//   - listFlags: merged effective set (workspace overrides over global).

export { evalFlag } from './evalFlag';
export { setFlag, FlagValidationError } from './setFlag';
export { listFlags } from './listFlags';
