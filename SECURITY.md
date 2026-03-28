# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in ata-validator, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email mertgold60@gmail.com with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 48 hours and work with you on a fix before any public disclosure.

## Scope

Security issues we care about:

- ReDoS vulnerabilities in pattern validation (ata uses RE2 which is immune, but report if you find a bypass)
- Buffer overflows or memory safety issues in the C++ layer
- Code injection through schema compilation (`new Function()` paths)
- Prototype pollution through validation or coercion

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x | Yes |
| < 0.4 | No |

## RE2 and ReDoS

ata-validator uses Google's RE2 regex engine for pattern validation. RE2 guarantees linear-time matching, which means catastrophic backtracking is not possible. This is a deliberate design choice for security.

If you find a pattern that causes unexpected behavior with RE2, please report it.
