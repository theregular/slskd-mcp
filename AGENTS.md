# Code readability

- Use a single blank line between logical steps or sections of code. For example, in `src/server.ts`, separate server construction, tool registration, and the final return.
- Keep closely related statements together when they form one logical step, such as computing a result and returning it. A blank line is not required before every return.
- Separate top-level declarations and distinct phases within longer functions where it improves readability.
- Preserve intentional spacing. Avoid inserting blank lines between every statement or object property, and avoid multiple consecutive blank lines.
- Follow the project's ESLint and Prettier configuration alongside these conventions.

## Public repository privacy

- Keep documentation and examples portable. Use placeholders instead of personal names, account details, absolute home-directory paths, or machine-specific setup notes.
- Do not commit credentials, local environment files, or private logs. Use `.env.example` with empty credential values for configuration examples.
