# Filename Escaping Rules

ArcRho uses reversible escaping when text that may contain Windows-invalid filename
characters must be written as a file or folder name.

## Goal

The encoded name must be valid on Windows and must decode back to the exact original
name for the supported character set.

## Previous Rule

The previous filename sanitizer replaced each Windows-invalid filename character
with `_`. This was simple but not reversible, because different original characters
could produce the same sanitized filename.

Example:

```text
Input:  Alpha/Beta:Q1?
Output: Alpha_Beta_Q1_
```

## Escape Format

Encode each invalid character as:

```text
_%XX_
```

`XX` is the uppercase two-digit hexadecimal character code.

## Character Mapping

| Original character | Encoded expression |
| --- | --- |
| `\` | `_%5C_` |
| `/` | `_%2F_` |
| `:` | `_%3A_` |
| `*` | `_%2A_` |
| `?` | `_%3F_` |
| `"` | `_%22_` |
| `<` | `_%3C_` |
| `>` | `_%3E_` |
| `|` | `_%7C_` |

## Encoding Rule

Only replace the Windows-invalid filename characters listed above. Leave all other
characters unchanged.

Example:

```text
Input:  Alpha/Beta:Q1?
Output: Alpha_%2F_Beta_%3A_Q1_%3F_
```

## Decoding Rule

When reading the name back, convert every escape expression matching this pattern:

```text
_%[0-9A-F][0-9A-F]_
```

back to the character represented by the hexadecimal value.

## Assumption

Original names are assumed to never contain the literal sequence `_%`. Because of
that assumption, `%` and `_` do not need to be escaped by themselves.

If ArcRho ever needs to support original names containing `_%`, update the format to
also encode `%` as `_%25_` before decoding arbitrary user-provided names.

## Windows Filename Notes

This rule handles invalid characters only. Windows also has reserved filename cases
such as `CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, `LPT1` through `LPT9`,
and names ending in a space or period. Handle those separately if the source names
can produce them.
