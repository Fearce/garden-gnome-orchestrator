# Approved task integration

Authenticated `prompt.direct` callers may send `skipSelfImprovement: true` when an approved brief excludes optional follow-up work. The hello snapshot advertises `skipSelfImprovementSupported: true`; callers must check it before relying on the policy. Missing support should stop submission, not silently fall back.

The director passes the restriction into dispatch. It is persisted before enqueue and retained across a from-scratch retry. The completion gate skips only this task's optional self-improvement round. Normal implementation and QA remain configured normally, and all other tasks retain the existing global setting.

This restriction is not a filesystem sandbox or a guarantee that model instructions constrain every edit. Review the actual diff and acceptance checks. It prevents the specific automatic extra round that changed a file after GnomeOps' approved documentation task completed.

Verification: `npm run test:self-improve-restart --prefix server` exercises real dispatch, persistence, retry, and completion gates with model-spawning leaves stubbed. No inference is needed.
