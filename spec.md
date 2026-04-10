# IntelliSense Recursion — Peek/Navigation Spec

## Overview

This extension adds Cmd+Click navigation on type names in hover preview panels,
similar to IntelliJ IDEA's hover peek behavior. This spec defines what a correct
implementation must guarantee.

---

## 1. Hover Preview Generation

### 1.1 Type Extraction from Hover Content

When VS Code shows a hover tooltip, the language server returns markdown with code
fences. This extension extracts type names from those code fences.

**Extraction rule**: Match `/\b[A-Za-z_]\w*\b/g`, then filter:
- Must start with uppercase (`/^[A-Z]/`)
- Must be > 1 character
- Must not be in SKIP_WORDS (89 entries: primitives, keywords, builtins)
- Deduplicated (first occurrence only)
- Maximum 3 types per hover event

**Example hover content and extraction:**

```
# Python: hovering on `user: User`
```python
class User(TimestampedModel):
    name: str
    email: str
```
→ Extracted: [User, TimestampedModel]
→ Skipped: str (primitive), name/email (lowercase)

# TypeScript: hovering on `profile: UserProfile`
```typescript
(alias) interface UserProfile extends TimestampedEntity
import UserProfile
```
→ Extracted: [UserProfile, TimestampedEntity]
→ Skipped: alias (lowercase), interface (keyword), import (keyword)

# Go: hovering on `user UserProfile`
```go
type UserProfile struct {
    TimestampedEntity
    Name  string
    Email string
}
```
→ Extracted: [UserProfile, TimestampedEntity]
→ Skipped: Name/Email (field names match PascalCase — but Go convention accepted)

# Rust: hovering on `entity: TimestampedEntity`
```rust
pub struct TimestampedEntity {
    pub base: BaseEntity,
    pub updated_at: SystemTime,
}
```
→ Extracted: [TimestampedEntity, BaseEntity, SystemTime]
```

### 1.2 Types That MUST Be Extracted

| Pattern | Example | Extracted |
|---------|---------|-----------|
| Class name | `class HttpResponseBase:` | `HttpResponseBase` |
| Interface name | `interface FormikProps<Values>` | `FormikProps`, `Values` |
| Type alias | `type MutationTuple = [...]` | `MutationTuple` |
| Return type | `→ UserProfile \| null` | `UserProfile` |
| Generic parameter | `List[User]`, `Optional[Company]` | `User`, `Company` |
| Union member | `UserProfile \| CompanyInfo` | `UserProfile`, `CompanyInfo` |
| Inheritance parent | `extends TimestampedEntity` | `TimestampedEntity` |
| Struct embedding | `TimestampedEntity` (Go) | `TimestampedEntity` |
| Field type | `owner: UserProfile` | `UserProfile` |
| Enum variant | `class TextChoices(StrEnum)` | `TextChoices`, `StrEnum` |

### 1.3 Types That MUST NOT Be Extracted

| Category | Examples | Reason |
|----------|---------|--------|
| Primitives | `str`, `int`, `float`, `bool`, `string`, `number` | SKIP_WORDS |
| Typing constructs | `Any`, `Optional`, `Union`, `Callable`, `Type`, `Self`, `Never`, `Generic`, `NotRequired`, `Annotated`, `ParamSpec` | SKIP_WORDS |
| Keywords | `class`, `def`, `interface`, `import`, `export` | SKIP_WORDS |
| JS/TS builtin objects | `String`, `Number`, `Boolean`, `Object`, `Function` | SKIP_WORDS |
| Python constants | `None`, `True`, `False` | SKIP_WORDS |
| Lowercase identifiers | `name`, `value`, `data`, `result` | Not PascalCase |
| camelCase identifiers | `userName`, `getData`, `createUser` | Not PascalCase |
| Single characters | `T`, `K`, `V` (generic params) | Length ≤ 1 |

### 1.4 Definition Preview Content

For each extracted type, a preview is generated and appended to the hover:

```markdown
---
`TypeName` — *path/to/file.py:42*
```python
class TypeName(ParentClass):
    """Docstring."""
    field_a: str
    field_b: int
    ... (up to 15 lines)
```
```

Rules:
- Maximum 15 lines from definition start
- File path shown as workspace-relative
- Language ID from document (python, typescript, go, etc.)
- Preview code itself contains type names → those are also clickable

### 1.5 No Duplication

| Rule | Mechanism |
|------|-----------|
| Same hover event, multiple provider handles | Dedup by `uri:line:character` key, 200ms window |
| Successive hovers on same position | Content must not grow; later calls ≤ first call size |
| Same code fence in combined output | Each unique fence appears exactly once |
| Same preview block across providers | Deduplicated by content comparison |

---

## 2. Click Navigation (goToType)

### 2.1 Identifier Acceptance Gate

Before any resolution begins, the clicked identifier is checked:

```
ACCEPT if:
  - Starts with uppercase: /^[A-Z]/.test(identifier)
  - OR contains underscore: identifier.includes('_')  (for UPPER_CASE constants)

REJECT if:
  - camelCase: `userName`, `getData`, `clearFieldOnUnmount`
  - lowercase: `name`, `value`, `other`, `inst`, `react`
  - Language keyword (already filtered by renderer, but double-checked)
```

### 2.2 Resolution Steps (ordered by speed)

```
Step 1: defLine scan         [0-5ms]    ← Pure regex on open documents
Step 2: import-follow        [1-500ms]  ← Parse import → find file → scan for def
Step 3: defProvider           [1-5000ms] ← Language server definition API
Step 4: hover fallback        [1-5000ms] ← Language server hover API
```

Each step is attempted only if the previous step returned no result.

#### Step 1: defLine Scan (regex, no language server)

Scans all open documents for definition-like patterns:

**Definition keyword regex:**
```regex
^[ \t]*(?:export[ \t]+)?(?:class|interface|struct|enum|type|def|fn|func|
  pub[ \t]+(?:struct|enum|fn))[ \t]+IDENTIFIER\b
```

**Assignment regex** (for PascalCase identifiers only):
```regex
^IDENTIFIER[ \t]*(?::[ \t]*\w+)?[ \t]*=[ \t]*
```

**Matches:**
| Language | Pattern | Example |
|----------|---------|---------|
| Python | `class X:` | `class HttpResponseBase:` |
| Python | `class X(Parent):` | `class User(TimestampedModel):` |
| Python | `def X(` | `def get_display_name(self):` |
| TypeScript | `interface X` | `export interface UserProfile extends ...` |
| TypeScript | `type X =` | `export type FormikProps<V> = ...` |
| TypeScript | `class X` | `export class UserService {` |
| TypeScript | `enum X` | `enum Status {` |
| Go | `type X struct` | `type UserProfile struct {` |
| Go | `type X interface` | `type Reader interface {` |
| Rust | `pub struct X` | `pub struct UserProfile {` |
| Rust | `pub enum X` | `pub enum Status {` |
| Java | `class X` | `public class UserProfile extends ...` |
| C# | `class X` | `public class UserProfile : ...` |
| Dart | `class X` | `class UserProfile extends ...` |
| Assignment | `X = value` | `MutableMapping = _alias(...)` |
| Assignment | `X: Type = value` | `Sequence: TypeAlias = ...` |

**Position precision:** The cursor jumps to the identifier itself (not the keyword):
- `class ▸HttpResponseBase:` ← cursor here, not at `class`

#### Step 2: Import-Follow (file resolution, no language server)

Parses import statements in open documents to trace the identifier to its source.

**Python import patterns:**

| Pattern | Regex | Example |
|---------|-------|---------|
| Single-line | `^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+.*\bX\b` | `from models import User` |
| Multi-line | `^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]*\([^)]*\bX\b[^)]*\)` (with `ms` flag) | `from typing import (\n  Any,\n  Callable,\n)` |

**Module path resolution (Python):**
```
"zuzu.db.mixins" → search for:
  **/zuzu/db/mixins.py
  **/zuzu/db/mixins/__init__.py
  **/zuzu/db/mixins.pyi

File selection priority:
  1. Project files (zuzu/...)
  2. .venv/site-packages/... (sorted by path length, shorter = more direct)
```

**TypeScript/JavaScript import patterns:**

| Pattern | Regex | Example |
|---------|-------|---------|
| Named import | `import[ \t]+\{[^}]*\bX\b[^}]*\}[ \t]+from[ \t]+['"]P['"]` | `import { FormikProps } from 'formik'` |
| Default import | `import[ \t]+X[ \t]+from[ \t]+['"]P['"]` | `import React from 'react'` |
| Multi-line | Same regex with `s` flag | `import {\n  FormikProps,\n} from 'formik'` |

**Path resolution (TypeScript/JavaScript):**

Relative imports (`./`, `../`):
```
"./models" → try in order:
  ./models.ts
  ./models.tsx
  ./models.js
  ./models.jsx
  ./models/index.ts
  ./models/index.tsx
  ./models/index.js
```

Package imports (`formik`, `@emotion/react`):
```
"formik" → resolution chain:
  1. Find node_modules/formik/package.json
  2. Read "types" or "typings" field → "dist/index.d.ts"
  3. Open dist/index.d.ts, scan for definition
  4. If not found, follow re-exports:
     - export { FormikProps } from './types'  → scan dist/types.d.ts
     - export * from './types'                → scan dist/types.d.ts
  5. Fallback: try node_modules/formik/index.d.ts
  6. Fallback: try node_modules/@types/formik/index.d.ts
```

**Re-export chain tracking:**
```typescript
// node_modules/formik/dist/index.d.ts
export * from './Formik';      ← check Formik.d.ts
export * from './types';       ← check types.d.ts ← FormikProps is here
export * from './connect';

// Each star-export file is scanned with findDefInText()
// Named re-exports: export { X } from './sub' — also traced
```

#### Step 3: defProvider (language server API)

Calls `vscode.executeDefinitionProvider` on each text match of the identifier.

**Behavior:**
```
For each open document:
  Find all regex matches of \bIDENTIFIER\b (max 20)
  For each match position:
    Call executeDefinitionProvider(uri, position)
    Timeout: 5 seconds per call
    If first call > 3s → mark file as "slow" → skip remaining matches

Result handling:
  - Location: { uri, range }           → use directly
  - LocationLink: { targetUri, targetRange } → normalize to { uri, range }
  - Self-reference check (see §6)
  - First valid result → navigate and return
```

#### Step 4: Hover Fallback

Last resort: opens the document at the match position and shows hover.

```
For each document with a regex match:
  Call executeHoverProvider(uri, position)
  If hover returned:
    Open document at position
    Trigger editor.action.showHover
    Return
```

### 2.3 Target Accuracy Matrix

**Expected navigation results by identifier type:**

| Identifier | Source | Expected Target | Method |
|------------|--------|-----------------|--------|
| `HttpResponseBase` | Django hover preview | `django/http/response.py` → `class HttpResponseBase:` | defLine |
| `FormikProps` | Formik type in TSX | `formik/dist/types.d.ts` → `export type FormikProps<V>` | import-follow |
| `ArithmeticError` | Python builtin | `builtins.pyi` → `class ArithmeticError(Exception)` | defLine |
| `CompanyQuestionThreadQuerySet` | Project class | `company_question_thread.py` → `class CompanyQuestionThreadQuerySet(...)` | defLine |
| `TextChoices` | Django enum | `django/db/models/enums.py` → `class TextChoices(...)` | defProvider |
| `TypeError` | Python exception | `builtins.pyi` → `class TypeError(Exception)` | defProvider |
| `Subquery` | Django expression | `django/db/models/expressions.py` → `class Subquery(...)` | defLine |
| `ServiceContext` | Project class | `zuzu/common/services/service.py` → `class ServiceContext:` | import-follow |
| `SoftDeletableModel` | Third-party mixin | `model_utils/models.py` → `class SoftDeletableModel(...)` | import-follow |
| `MutableMapping` | Python typing alias | `typing.py` → `MutableMapping = _alias(...)` | defLine (assign) |

**Cases that should NOT navigate (rejected at gate):**

| Identifier | Reason |
|------------|--------|
| `react` | Lowercase, not PascalCase |
| `name` | Lowercase, common variable |
| `inst` | Lowercase parameter name |
| `clearFieldOnUnmount` | camelCase prop name |
| `useDeferredValue` | camelCase React hook |
| `newPasswordConfirm` | camelCase form field |

**Cases where no result is acceptable:**

| Identifier | Reason |
|------------|--------|
| `Values` | Generic type parameter, no concrete definition |
| `TData` | Generic type parameter |
| `Props` | Generic/local type not in open docs |
| `Omit` | TypeScript utility type (built into compiler) |

### 2.4 LocationLink Compatibility

VS Code's `executeDefinitionProvider` returns two possible formats:

```typescript
// Format 1: Location (Python/Pylance typically)
{ uri: Uri, range: Range }

// Format 2: LocationLink (TypeScript LS typically)
{ targetUri: Uri, targetRange: Range, targetSelectionRange?: Range, originSelectionRange?: Range }
```

The `normalizeDef()` function handles both:
```typescript
if (d.targetUri) → { uri: d.targetUri, range: d.targetRange || d.targetSelectionRange }
if (d.uri)       → { uri: d.uri, range: d.range }
```

**Impact of missing this:** TS language server results silently dropped → fallback to hover
→ navigates to import line instead of actual definition.

---

## 3. Cross-Language Hover Content Patterns

### 3.1 Python Hover Patterns

**What Pylance/Jedi returns in hover code fences:**

```python
# Hovering on a class instance variable
(variable) user: User

# Hovering on a function call
(function) def create_user(name: str, email: str) -> User

# Hovering on a class name in inheritance
(class) class User(TimestampedModel)

# Hovering on a method
(method) def get_display_name(self) -> str

# Hovering on a module attribute
(variable) models: module

# Hovering on a type annotation
(class) class Optional
```

**Type extraction from these:**
- `(variable) user: User` → `User`
- `def create_user(...) -> User` → `User`
- `class User(TimestampedModel)` → `User`, `TimestampedModel`
- `def get_display_name(self) -> str` → (nothing, `str` is skipped)
- `(class) class Optional` → (nothing, `Optional` is in SKIP_WORDS)

**Python-specific gotchas:**
- `models.Model` — `Model` not directly imported, accessed via `models.` prefix. defLine won't find `class Model` in open docs. Requires defProvider or import-follow on `django.db.models`.
- `from __future__ import annotations` — Changes type annotation evaluation; hover may show string literals
- `TYPE_CHECKING` imports — Types imported only for type checking, may not have runtime definitions
- Multi-line `from typing import (\n  Any,\n  Callable,\n  Optional,\n)` — Requires multi-line regex with `ms` flags

### 3.2 TypeScript Hover Patterns

**What TS language server returns in hover code fences:**

```typescript
// Hovering on an interface usage
(alias) interface UserProfile
import UserProfile

// Hovering on a function
function createUser(name: string, email: string): UserProfile

// Hovering on a generic type
(alias) type FormikProps<Values> = FormikSharedConfig & FormikState<Values> & ...

// Hovering on a const
const VALIDATE_PASSWORD_RESET_TOKEN: DocumentNode

// Hovering on a React component
(alias) const PageLoader: React.FC<LoaderProps>

// Hovering on a hook
function useMutation<TData, TVariables>(mutation: DocumentNode, options?: MutationHookOptions<TData, TVariables>): MutationTuple<TData, TVariables>
```

**Type extraction from these:**
- `interface UserProfile` → `UserProfile`
- `createUser(...): UserProfile` → `UserProfile`
- `FormikProps<Values> = FormikSharedConfig & FormikState<Values>` → `FormikProps`, `Values`, `FormikSharedConfig`, `FormikState`
- `const VALIDATE_PASSWORD_RESET_TOKEN: DocumentNode` → `VALIDATE_PASSWORD_RESET_TOKEN`, `DocumentNode`
- `React.FC<LoaderProps>` → `React` (skipped?), `FC` (2 chars, skipped), `LoaderProps`
- `MutationHookOptions<TData, TVariables>` → `MutationHookOptions`, `TData`, `TVariables`

**TypeScript-specific gotchas:**
- `auto-imports.d.ts` — Auto-generated file with patterns like `const useDeferredValue: typeof import('react').useDeferredValue`. Not a standard import, not traceable by import-follow.
- Re-export chains — `formik/dist/index.d.ts` → `export * from './types'` → actual definition in `types.d.ts`
- Conditional types — `T extends U ? X : Y` — extracts `U`, `X`, `Y` as types
- Mapped types — `{ [K in keyof T]: V }` — extracts `T`, `V`
- Intersection types — `A & B & C` — extracts `A`, `B`, `C`
- Utility types — `Omit<T, K>`, `Pick<T, K>`, `Partial<T>` — `Omit`/`Pick`/`Partial` are compiler built-ins, no file to navigate to

### 3.3 Go Hover Patterns

```go
// Hovering on a struct field
field Owner UserProfile

// Hovering on a function parameter
func GetCompanyOwner(company CompanyInfo) UserProfile

// Hovering on an embedded struct
type CompanyInfo struct {
    TimestampedEntity
    Title   string
}
```

**Go-specific gotchas:**
- Embedded structs appear as bare type names in struct body (no field name)
- Go uses PascalCase for exported names, so field names like `Name`, `Email` will be extracted as "types"
- Should these be filtered? Debatable — in Go, `Name` COULD be a type

### 3.4 Rust Hover Patterns

```rust
// Hovering on a struct field
pub entity: TimestampedEntity

// Hovering on a function return
fn create_user(name: &str, email: &str) -> UserProfile

// Hovering on an impl
impl CompanyInfo { ... }
```

**Rust-specific gotchas:**
- `impl Trait for Type` — both `Trait` and `Type` should be extracted
- `&UserProfile` — reference prefix `&` doesn't affect extraction
- `Vec<UserProfile>` — extracts `Vec` (which is std) and `UserProfile`

### 3.5 Java Hover Patterns

```java
// Hovering on a method return
public UserProfile createUser(String name, String email)

// Hovering on class inheritance
public class UserProfile extends TimestampedEntity
```

**Java-specific gotchas:**
- One class per file — `UserProfile.java` contains `class UserProfile`
- `String`, `Integer`, `List` etc. are PascalCase but stdlib — need to handle
- Java generics: `List<UserProfile>` → `List`, `UserProfile`

---

## 4. Link Pattern Catalog (Real-World)

Derived from analysis of a production Django + React codebase (~200K LOC).
Each pattern is named, categorized by where it's defined and how the extension should resolve it.

### 4.1 Pattern Classification

Every clickable type name in a hover preview falls into one of these resolution categories:

| Category | Where defined | Resolution method | Speed |
|----------|---------------|-------------------|-------|
| **LOCAL** | Same project source | defLine scan | <5ms |
| **SIBLING** | Other project file | defLine or import-follow | <100ms |
| **STDLIB** | Python stdlib / TS lib | defLine on open stub file | <5ms |
| **FRAMEWORK** | .venv (Django, etc.) | defLine or defProvider | <5ms–5s |
| **PACKAGE** | node_modules | import-follow (package.json) | <500ms |
| **GENERATED** | Auto-generated files | defLine on open file | <5ms |
| **BUILTIN** | Language built-in (no file) | No navigation (acceptable) | 0ms |
| **GENERIC** | Type parameter (no concrete def) | No navigation (acceptable) | 0ms |

### 4.2 Python/Django Link Patterns

#### P01: Django Model Class
```python
# Definition: zuzu/db/models/registration.py
class Registration(TimestampedModel):
    meeting: "models.ForeignKey[Meeting, Meeting]"
```
- **Hover shows**: `(class) class Registration(TimestampedModel)`
- **Clickable types**: `Registration` (LOCAL), `TimestampedModel` (SIBLING)
- **Resolution**: defLine → `class Registration` in open file

#### P02: Custom QuerySet
```python
# Definition: zuzu/db/models/registration.py
class RegistrationQuerySet(QuerySet["Registration"]):
    def active(self) -> Self: ...
```
- **Hover shows**: `(class) class RegistrationQuerySet(QuerySet[Registration])`
- **Clickable types**: `RegistrationQuerySet` (LOCAL), `QuerySet` (FRAMEWORK), `Registration` (LOCAL)
- **Resolution**: defLine for local, defProvider for `QuerySet`

#### P03: Custom Manager
```python
# Definition: zuzu/db/models/registration.py
class RegistrationManager(models.Manager["Registration"]):
    def get_queryset(self) -> RegistrationQuerySet: ...
```
- **Clickable types**: `RegistrationManager` (LOCAL), `Manager` (FRAMEWORK), `RegistrationQuerySet` (LOCAL)

#### P04: Mixin / Abstract Base
```python
# Definition: zuzu/common/models/soft_deletable.py
class SoftDeletableModel(models.Model):
    is_removed: BooleanField
    class Meta: abstract = True
```
- **Clickable types**: `SoftDeletableModel` (SIBLING), `BooleanField` (FRAMEWORK)
- **Resolution**: import-follow `from zuzu.common.models import SoftDeletableModel`

#### P05: Protocol Class
```python
# Definition: zuzu/common/models/protocol.py
class QuerySetProtocol(Protocol):
    def filter(self, **kwargs: Any) -> Self: ...
```
- **Clickable types**: `QuerySetProtocol` (SIBLING), `Protocol` (STDLIB)

#### P06: TypedDict
```python
# Definition: zuzu/app/graphql/types/ceo_address_change_input.py
class CeoAddressChangeInput(TypedDict):
    ceo_name: str
    road_address: NotRequired[str]
```
- **Clickable types**: `CeoAddressChangeInput` (LOCAL), `TypedDict` (STDLIB), `NotRequired` (STDLIB)

#### P07: Dataclass
```python
@dataclass
class DirectorInputError:
    field: str
    message: str
```
- **Clickable types**: `DirectorInputError` (LOCAL)

#### P08: Enum Choice Class
```python
# Definition: zuzu/vcm/types.py
class VcmApprovalStatusType(TextChoices):
    PENDING = "pending", "대기"
    APPROVED = "approved", "승인"
```
- **Clickable types**: `VcmApprovalStatusType` (LOCAL), `TextChoices` (FRAMEWORK)

#### P09: Exception Class
```python
# Definition: zuzu/common/exception.py
class EditForbidden(Exception): ...
class DuplicatedEmail(Exception): ...
```
- **Clickable types**: `EditForbidden` (SIBLING), `Exception` (STDLIB)
- **Resolution**: import-follow `from zuzu.common.exception import EditForbidden`

#### P10: Service Class
```python
# Definition: zuzu/common/services/service.py
class ServiceContext:
    user: AppUser
    company: Company
class Service:
    context: ServiceContext
```
- **Clickable types**: `ServiceContext` (SIBLING), `Service` (SIBLING), `AppUser` (SIBLING), `Company` (SIBLING)

#### P11: GraphQL ObjectType
```python
# Definition: zuzu/app/graphql/types/option_grant_activity_type.py
class OptionGrantActivityType(DjangoObjectType):
    user = TypedField(typed_lazy_import_by_name("UserType"))
```
- **Clickable types**: `OptionGrantActivityType` (LOCAL), `DjangoObjectType` (PACKAGE)

#### P12: TypeVar / Generic
```python
_T_co = TypeVar("_T_co", bound="SealStampImage", covariant=True)
class SealStampImageManager(FileAttachmentManager[_T_co]): ...
```
- **Clickable types**: `FileAttachmentManager` (SIBLING), `SealStampImage` (LOCAL)
- **`_T_co`**: Not PascalCase → not clickable (correct)

#### P13: Django HTTP Types
```python
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
```
- **Hover shows**: `(class) class HttpResponse(HttpResponseBase)`
- **Clickable types**: `HttpResponse` (FRAMEWORK), `HttpResponseBase` (FRAMEWORK)
- **Resolution**: defLine if response.py is open; otherwise defProvider or import-follow

#### P14: Forward Reference (string type)
```python
if TYPE_CHECKING:
    from .meeting import Meeting
meeting: "models.ForeignKey[Meeting, Meeting]"
```
- **Clickable types in hover**: `Meeting` (SIBLING, but conditionally imported)
- **Resolution**: import-follow parses TYPE_CHECKING block imports? Currently: regex may miss these.

#### P15: Lazy Import (string path)
```python
agenda = TypedField(lazy_import(
    "zuzu.app.graphql.types.directors_meeting_agenda_type.DirectorsMeetingAgendaType"
))
```
- **Not clickable**: String argument, not a type annotation
- **Out of scope**: Would require string argument parsing

#### P16: Dotted Access Type
```python
from django.db import models
class User(models.Model): ...
```
- **Hover shows**: `(class) class User(Model)`
- **`Model` in hover**: `Model` is extracted, but `class Model` is not in any open doc
- **Resolution**: import-follow cannot trace `models.Model` (dotted access). defProvider needed.

### 4.3 TypeScript/React Link Patterns

#### T01: React Component Props
```typescript
// Definition: common/ui/grid-layout.tsx
export interface GridLayoutProps {
  columns?: number;
  gap?: string;
  children: ReactNode;
}
```
- **Clickable types**: `GridLayoutProps` (LOCAL), `ReactNode` (PACKAGE: react)

#### T02: Formik Integration Types
```typescript
// Usage: common/ui/form/form.tsx
import { FormikConfig, FormikProps, FormikHelpers } from 'formik';
export type FormProps<Values, TData> = Omit<FormikConfig<Values>, 'onSubmit'> & { ... }
```
- **Clickable types**: `FormProps` (LOCAL), `FormikConfig` (PACKAGE), `FormikProps` (PACKAGE), `Values` (GENERIC), `Omit` (BUILTIN)
- **Resolution**: `FormikProps` → import-follow → `formik/package.json` → `types: "dist/index.d.ts"` → `export * from './types'` → `dist/types.d.ts` → `export type FormikProps<V>`

#### T03: Apollo/GraphQL Types
```typescript
import { useMutation, gql, TypedDocumentNode } from '@apollo/client';
const VALIDATE_TOKEN = gql`mutation ValidateToken($token: String!) { ... }`;
```
- **Hover shows**: `const VALIDATE_TOKEN: DocumentNode`
- **Clickable types**: `DocumentNode` (PACKAGE: graphql), `TypedDocumentNode` (PACKAGE: @apollo/client)

#### T04: Generated GraphQL Types
```typescript
// Definition: legal/graphql-codegen/graphql.ts (auto-generated)
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type Scalars = { ID: { input: string; output: string }; ... };
export type Maybe<T> = T | null;
```
- **Clickable types**: `Exact` (GENERATED), `Scalars` (GENERATED), `Maybe` (GENERATED)
- **Resolution**: defLine in open generated file

#### T05: Custom Utility Types
```typescript
// Definition: common/typing.tsx
export type Ensure<T, K extends keyof T> = T & Required<Pick<T, K>>;
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
export type ResultOf<T> = T extends TypedDocumentNode<infer R, any> ? R : never;
```
- **Clickable types**: `Ensure` (LOCAL), `Prettify` (LOCAL), `ResultOf` (LOCAL)
- **Resolution**: defLine → `common/typing.tsx`

#### T06: Router Types (react-router-dom)
```typescript
// auto-imports.d.ts
const useSearchParams: typeof import('react-router-dom').useSearchParams
```
- **Hover shows**: `function useSearchParams(): [URLSearchParams, SetURLSearchParams]`
- **Clickable types**: `URLSearchParams` (BUILTIN: Web API), `SetURLSearchParams` (PACKAGE: react-router-dom)

#### T07: CSS-in-JS / Styled Types
```typescript
import type { Property } from "csstype";
alignItems?: StrictCSSType<Property.AlignItems>;
```
- **Hover shows**: `type StrictCSSType<T extends string> = T | (string & {})`
- **Clickable types**: `StrictCSSType` (LOCAL), `Property` (PACKAGE: csstype)

#### T08: DOM / Event Types
```typescript
onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
ref: React.RefObject<HTMLDivElement>;
```
- **Clickable types**: `MouseEvent` (BUILTIN: TypeScript lib), `HTMLButtonElement` (BUILTIN), `RefObject` (PACKAGE: react)

#### T09: Re-exported Package Type
```typescript
// formik/dist/index.d.ts
export * from './Formik';
export * from './types';    ← FormikProps is here
export * from './connect';
```
- **Resolution chain**: `import { FormikProps } from 'formik'` → `package.json#typings` → `dist/index.d.ts` → `export * from './types'` → `dist/types.d.ts:181`

#### T10: Scoped Package Type
```typescript
import { css, keyframes } from '@emotion/react';
```
- **Resolution**: `node_modules/@emotion/react/package.json` → `types` field → entry `.d.ts`

#### T11: auto-imports.d.ts Pattern
```typescript
// auto-imports.d.ts (auto-generated by unplugin-auto-import)
const useDeferredValue: typeof import('react').useDeferredValue
const useSearchParams: typeof import('react-router-dom').useSearchParams
```
- **Not a standard import**: `typeof import('pkg').X` pattern
- **Current handling**: defLine/import-follow fail → defProvider finds self-ref → hover fallback
- **Limitation**: Cannot trace `typeof import(...)` syntax

### 4.4 Pattern Resolution Summary

| ID | Pattern Name | Lang | Category | Best Resolution |
|----|-------------|------|----------|-----------------|
| P01 | Django Model Class | Py | LOCAL | defLine |
| P02 | Custom QuerySet | Py | LOCAL | defLine |
| P03 | Custom Manager | Py | LOCAL | defLine |
| P04 | Mixin / Abstract Base | Py | SIBLING | import-follow |
| P05 | Protocol Class | Py | SIBLING | import-follow |
| P06 | TypedDict | Py | LOCAL | defLine |
| P07 | Dataclass | Py | LOCAL | defLine |
| P08 | Enum Choice Class | Py | LOCAL | defLine |
| P09 | Exception Class | Py | SIBLING | import-follow |
| P10 | Service Class | Py | SIBLING | import-follow |
| P11 | GraphQL ObjectType | Py | LOCAL | defLine |
| P12 | TypeVar / Generic | Py | LOCAL | defLine (assign) |
| P13 | Django HTTP Types | Py | FRAMEWORK | defLine / defProvider |
| P14 | Forward Reference | Py | SIBLING | import-follow (TYPE_CHECKING) |
| P15 | Lazy Import | Py | — | Out of scope |
| P16 | Dotted Access Type | Py | FRAMEWORK | defProvider only |
| T01 | Component Props | TS | LOCAL | defLine |
| T02 | Formik Types | TS | PACKAGE | import-follow (re-export chain) |
| T03 | Apollo/GraphQL Types | TS | PACKAGE | import-follow |
| T04 | Generated GraphQL Types | TS | GENERATED | defLine |
| T05 | Custom Utility Types | TS | LOCAL | defLine |
| T06 | Router Types | TS | PACKAGE | import-follow |
| T07 | CSS-in-JS Types | TS | LOCAL+PACKAGE | defLine / import-follow |
| T08 | DOM / Event Types | TS | BUILTIN | No navigation (acceptable) |
| T09 | Re-exported Package Type | TS | PACKAGE | import-follow (star re-export) |
| T10 | Scoped Package Type | TS | PACKAGE | import-follow (@scope) |
| T11 | auto-imports.d.ts | TS | GENERATED | defProvider / hover fallback |

### 4.5 Resolution Expectation by Category

```
LOCAL      → defLine scan MUST find it in <5ms
SIBLING    → import-follow SHOULD find it in <100ms
STDLIB     → defLine on stub file if open; otherwise defProvider
FRAMEWORK  → defLine if file open; import-follow if import exists; defProvider fallback
PACKAGE    → import-follow via package.json + re-export chain in <500ms
GENERATED  → defLine if file open; otherwise same as LOCAL
BUILTIN    → No file exists; returning "not found" is acceptable
GENERIC    → Type parameter (T, Values, TData); "not found" is acceptable
```

---

## 5. Performance Requirements

| Metric | Target | Max Acceptable | Measured (real project) |
|--------|--------|----------------|------------------------|
| defLine scan | <5ms | 50ms | 0-2ms |
| import-follow | <100ms | 500ms | 1-650ms |
| defProvider (warm) | <50ms | 500ms | 3-30ms |
| defProvider (cold, stdlib) | N/A | 5s (timeout) | 5-16s (often times out) |
| Total navigation (best) | <5ms | 50ms | 0-2ms (defLine hit) |
| Total navigation (import) | <200ms | 1s | 16-652ms |
| Total navigation (worst) | <5s | 10s | 3-25s (all fallbacks) |
| Hover preview generation | <50ms | 200ms | 4-69ms |

### 5.1 Timeout Rules

| Mechanism | Timeout | Behavior on timeout |
|-----------|---------|---------------------|
| defProvider per call | 5s | Skip to next match |
| Slow file detection | 3s (first call) | Mark file, skip all remaining matches |
| Hover dedup window | 200ms | Return unaugmented result |
| Click debounce | 300ms | Ignore duplicate click |
| Renderer scan interval | 100ms | Re-scan on next tick |

---

## 6. Renderer Behavior

### 6.1 Type Wrapping Rules

The renderer (injected into VS Code's webview via CDP) scans `.rendered-markdown`
containers and wraps eligible identifiers in clickable `<span>` elements.

**Eligible identifier:** ALL of the following must be true:
1. Matches `/([a-zA-Z_][a-zA-Z0-9_]{2,})/g` (3+ chars, starts with letter/underscore)
2. Starts with uppercase: `/^[A-Z]/`
3. Not in renderer skip list (450+ entries)
4. Word boundary check passes (not part of a larger word)

**Renderer skip list categories (450+ words):**

| Category | Examples | Count |
|----------|---------|-------|
| Python keywords | `class`, `def`, `if`, `else`, `for`, `while`, `return` | ~30 |
| Python builtins | `self`, `cls`, `str`, `int`, `float`, `bool`, `list`, `dict` | ~20 |
| TS/JS keywords | `var`, `let`, `const`, `function`, `new`, `typeof`, `instanceof` | ~25 |
| TS/JS types | `null`, `undefined`, `true`, `false`, `number`, `string`, `boolean`, `any` | ~15 |
| Access modifiers | `public`, `private`, `protected`, `static`, `abstract`, `readonly` | ~10 |
| Python typing | `Any`, `Optional`, `Union`, `Literal`, `Final`, `Callable`, `Type`, `ClassVar`, `Protocol`, `TypeVar` | 10 |
| C/C++ keywords | `struct`, `union`, `typedef`, `extern`, `sizeof`, `namespace`, `template`, `virtual`, `constexpr` | ~20 |
| Common variables | `other`, `data`, `value`, `result`, `name`, `text`, `item`, `key`, `index`, `count`, `args`, `kwargs` | ~40 |
| Framework terms | `method`, `func`, `handler`, `request`, `response`, `context`, `config`, `error`, `message`, `content` | ~20 |
| English words | `the`, `that`, `will`, `are`, `has`, `can`, `should`, `all`, `each`, `every`, `some` | ~30 |
| Documentation | `Returns`, `Raises`, `Args`, `Parameters`, `Note`, `Example`, `param`, `deprecated` | ~15 |

### 6.2 DOM Wrapping Process

```
Every 100ms:
  For each .rendered-markdown container:
    If already has .ir-type-link → skip (already processed)
    Extract textContent
    Find PascalCase identifiers not in skip list
    TreeWalker over text nodes:
      For each identifier found in text node:
        Verify word boundary (check adjacent chars)
        splitText() to isolate identifier
        Wrap in <span class="ir-type-link" data-type="TypeName">
```

### 6.3 Click Flow

```
User holds Cmd → body gets class "ir-cmd-held"
  → .ir-type-link elements show underline + pointer cursor

User clicks on .ir-type-link while Cmd held:
  → preventDefault + stopPropagation
  → Extract data-type attribute
  → Call window.irGoToType(typeName)
  → CDP binding sends to extension host
  → goToTypeHandler(docUri, typeName) invoked
  → Resolution chain (§2.2) executes
```

---

## 7. Self-Reference Rules

When defProvider returns a result, it may point back to the same position we queried
(e.g., querying at `class UserProfile` returns the definition of `UserProfile` at the same spot).

| Query position | Definition result | Same file? | Same line? | Char ±3? | Def keyword on line? | Action |
|---------------|-------------------|------------|------------|----------|---------------------|--------|
| service.py:5 | models.py:42 | No | — | — | — | **Navigate** |
| models.py:10 | models.py:42 | Yes | No | — | — | **Navigate** |
| models.py:42:6 | models.py:42:6 | Yes | Yes | Yes | `class UserProfile` | **Navigate** (is the definition) |
| service.py:3:20 | service.py:3:20 | Yes | Yes | Yes | `from models import UserProfile` | **Skip** (import line, not def) |
| form.tsx:19:2 | form.tsx:19:2 | Yes | Yes | Yes | `import { FormikConfig }` | **Skip** (import line) |
| types.d.ts:181:0 | types.d.ts:181:0 | Yes | Yes | Yes | `export type FormikProps<V>` | **Navigate** (is the definition) |

**Definition keywords that make self-ref acceptable:**
```regex
/^\s*(?:export\s+)?(?:class|interface|type|enum|const|let|var|function|def|struct)\s+/
```

---

## 8. Test Scenarios

### 8.1 Basic Navigation (per language × 9 languages)
- [ ] Hover on type annotation returns non-empty content
- [ ] Definition provider resolves type to correct file
- [ ] Hover on base class resolves parent type
- [ ] Definition chain: service file → models file
- [ ] Definition from models resolves inheritance

### 8.2 Duplication Prevention
- [ ] Hover content has no duplicate previews (≤4 separators, ≤5 code fences)
- [ ] 5 successive hovers on same position: no content growth
- [ ] Preview blocks not duplicated across hover provider objects
- [ ] No identical code fences in combined hover text

### 8.3 Navigation Accuracy (Python)
- [ ] `Any` (from `typing`) → resolves to stdlib typing, not random file
- [ ] `HttpResponseBase` → `django/http/response.py` class definition
- [ ] `TextChoices` → `django/db/models/enums.py` class definition
- [ ] `ArithmeticError` → `builtins.pyi` class definition
- [ ] `TimestampedModel` (import in open file) → project mixin file or model_utils
- [ ] `SoftDeletableModel` (import in open file) → project mixin file
- [ ] `ServiceContext` (import in open file) → project service file
- [ ] `CompanyQuestionThreadQuerySet` (class in open file) → same file definition
- [ ] `get_display_name` (method call) → class definition in models file
- [ ] `Model` (via `models.Model`) → django.db.models.base (may require defProvider)

### 8.4 Navigation Accuracy (TypeScript)
- [ ] `UserProfile` (imported interface) → models.ts interface definition
- [ ] `CompanyInfo` (nested property type) → models.ts interface definition
- [ ] `FormikProps` (package import) → formik/dist/types.d.ts type definition
- [ ] `FormikConfig` (package import) → formik/dist/types.d.ts interface definition
- [ ] `VALIDATE_PASSWORD_RESET_TOKEN` (const) → same file const declaration
- [ ] `PageLoader` (component import) → source component file
- [ ] `DocumentNode` (from @apollo/client) → apollo package types

### 8.5 Import Resolution
- [ ] Python single-line `from models import User` → `models.py` → `class User`
- [ ] Python multi-line `from typing import (\n  Callable,\n)` → `typing.py` or typeshed
- [ ] Python dotted path `from zuzu.db.mixins import X` → `zuzu/db/mixins.py` or `__init__.py`
- [ ] Python prefers project files over `.venv` for same module name
- [ ] TypeScript relative `import { X } from './models'` → `models.ts`
- [ ] TypeScript package `import { X } from 'formik'` → via package.json types
- [ ] TypeScript `export * from './types'` re-export chain → traced to definition
- [ ] TypeScript `export { X } from './sub'` named re-export → traced
- [ ] TypeScript scoped `import { X } from '@emotion/react'` → node_modules/@emotion/react

### 8.6 Edge Cases
- [ ] Generic types: `List[User]` hover extracts `User`, not `List`
- [ ] Union types: `A | B` hover extracts both `A` and `B`
- [ ] Intersection: `A & B & C` extracts all three
- [ ] Assignment definitions: `MutableMapping = _alias(...)` found by defLine scan
- [ ] `.pyi` stub files: `class ArithmeticError(Exception): ...` navigated correctly
- [ ] Deep inheritance (3+ levels): A → B → C each navigable step by step
- [ ] `.venv` files: defProvider may return 0; defLine scan still works
- [ ] Go PascalCase fields: `Name`, `Email` are capitalized but are fields, not types
- [ ] Multiple definitions: same name in different files → prefer preview loc → priority doc order

### 8.7 Rejection Cases
- [ ] camelCase not clickable: `userName`, `getData`, `clearFieldOnUnmount`
- [ ] Lowercase not clickable: `name`, `value`, `other`, `inst`
- [ ] camelCase not navigated: `goToTypeHandler` receives but rejects at gate
- [ ] Keywords not clickable: `class`, `def`, `import`, `export`
- [ ] Builtins not clickable: `Any`, `Optional`, `Callable`, `Union`
- [ ] Short identifiers not extracted: `T`, `K`, `V` (single letter generic params)
- [ ] Self-reference on import line skipped (not navigated)
- [ ] Self-reference on def line accepted (correctly navigated)

### 8.8 Performance
- [ ] defLine scan: <5ms for 50KB file
- [ ] import-follow: <500ms including findFiles
- [ ] defProvider: 5s timeout enforced per call
- [ ] Slow file: marked after first 3s+ call, remaining matches skipped
- [ ] Total worst-case: <10s (defProvider timeout + hover fallback)
- [ ] Hover preview generation: <200ms for 3 type previews

---

## 9. Document Priority & State Management

### 9.1 Document Search Order

When resolving an identifier, documents are searched in this priority:

```
1. previewLoc document — file where the hover preview was generated from
2. lastHoverDocUri     — file where the user triggered the hover
3. docUriStr           — document URI passed from the click event
4. activeTextEditor    — currently focused editor
5. workspace.textDocuments — all other open documents (filtered by isCodeDoc)
```

Deduplication: each URI appears only once. Non-code documents are excluded
(`.log`, `.git`, `scm://`, `output://`).

### 9.2 State Lifecycle

| State | Set when | Cleared when | Used by |
|-------|----------|-------------|---------|
| `lastPreviewLocations` (Map) | Hover preview adds type→location entries | Never cleared (accumulates) | Step 1 doc ordering |
| `lastHoverDocUri` (string) | `$provideHover` runs with new content | Overwritten on each hover | Step 2 import-follow |
| `lastPreviewKey` (string) | Preview successfully appended | Overwritten on next hover | Hover dedup |
| `lastPreviewTime` (number) | Preview successfully appended | Overwritten on next hover | Hover dedup (200ms window) |
| `hoverRecursionDepth` (number) | Incremented on preview resolution | Decremented in finally block | Recursion guard |
| `hoverPatchActive` (boolean) | `patchSharedService()` completes | Never cleared | Integration test gate |

**Risk**: `lastPreviewLocations` grows unboundedly over session. Large map (~1000+ entries)
is acceptable for memory but may cause stale entries to point to wrong locations if files change.

### 9.3 Graceful Degradation

| Failure | Behavior | User sees |
|---------|----------|-----------|
| `findSharedHoverService()` fails | No hover preview augmentation | Normal VS Code hover (no type previews) |
| CDP injection fails | No clickable type links | Hover shows previews but links are plain text |
| defLine scan finds nothing | Falls through to import-follow | Slight delay (<500ms) |
| import-follow finds nothing | Falls through to defProvider | Potential 1-5s delay |
| defProvider times out (5s) | Skips file, tries next | Up to 5s wasted per slow file |
| All steps fail | Log warning, no navigation | Nothing happens on click |
| Language server not ready | defProvider returns 0 | Falls back to defLine (which may still work) |

### 9.4 CDP Injection Reliability

| Phase | Mechanism | Failure mode |
|-------|-----------|-------------|
| Main process discovery | `ps aux` + PID filter | Fails if VS Code spawns multiple main processes |
| Inspector enable | `SIGUSR1` signal | Fails on Windows (different mechanism needed) |
| WebSocket connect | CDP target list → ws:// | Fails if inspector port occupied |
| Script injection | `Runtime.evaluate` per Electron window | Fails if CSP blocks eval |
| Re-injection | `setInterval` every 10s | New windows get patched with 0-10s delay |
| Click binding | `Runtime.addBinding("irGoToType")` | Lost on window reload → re-injection recovers |

---

## 10. Known Limitations

| Limitation | Pattern | Workaround |
|------------|---------|------------|
| Dotted access types | `models.Model` → `Model` extracted but `class Model` not in open docs | defProvider resolves (if LS is warm) |
| `typeof import()` syntax | `auto-imports.d.ts`: `typeof import('react').X` | Not traceable; hover fallback only |
| Lazy imports | `lazy_import("module.path.Type")` | String argument, out of scope |
| Forward references | `TYPE_CHECKING` block imports | import-follow may miss conditional blocks |
| Workspace symbols | Pylance consistently times out (3s+) | Removed from resolution chain |
| Multiple same-name types | `User` in models + `User` in schemas | Priority doc order determines which is found |
| Deep re-export chains | A→B→C→D (3+ levels) | Only 1 level of re-export is followed |
| Monorepo package refs | `@workspace/models` | Not resolved (no package.json → workspace mapping) |
| Go PascalCase fields | `Name`, `Email` are fields not types | Currently linkified (false positive in Go) |
| Renderer cache | Old renderer patch persists until window reload | PascalCase filter only in new patches |
| Python relative imports | `from ..models import X` | import-follow only handles absolute module paths |
| Python `__init__.py` barrel | `from .soft_deletable import *` re-export | import-follow finds `__init__.py` but def is in sub-module |
| TS bare specifier aliases | `import { X } from "common/ui/form"` (no `./`) | Webpack/Vite alias; import-follow can't resolve without bundler config |
| Python `Self` type | `Self` is PascalCase, passes filter, but is a typing construct | Should be in SKIP_WORDS |

### 10.1 Python `__init__.py` Barrel Export Problem

```python
# zuzu/common/models/__init__.py
from .soft_deletable import *     # re-exports SoftDeletableModel
from .timestamped import *        # re-exports TimestampedModel

# import-follow resolves:
#   "from zuzu.common.models import SoftDeletableModel"
#   → finds zuzu/common/models/__init__.py
#   → scans for "class SoftDeletableModel" → NOT FOUND
#   → should follow "from .soft_deletable import *" → soft_deletable.py
#   → CURRENTLY NOT IMPLEMENTED
```

**Impact**: SIBLING pattern (P04, P05, P09) resolution fails when definition is
in a sub-module re-exported via `__init__.py`. Falls through to defProvider (slow).

### 10.2 TypeScript Bare Specifier Alias Problem

```typescript
// password-reset-page.tsx
import { Form } from "common/ui/form/form";      // ← no "./" prefix
import { PageLoader } from "common/ui/loader";    // ← no "./" prefix

// These resolve via bundler config (Vite/Webpack):
//   "common/" → "src/common/"
//
// import-follow treats bare specifiers as package imports → searches node_modules
// → finds nothing → falls through to defProvider
```

**Impact**: LOCAL/SIBLING TypeScript types imported via bare alias appear as
PACKAGE resolution, which fails. defProvider or hover fallback needed.

---

## 11. Supported Languages

| Language | E2E Tests | Integration Tests | Hover Extraction | Import-Follow | defLine Scan | Status |
|----------|-----------|-------------------|-----------------|---------------|--------------|--------|
| Python | 12 tests | 6 tests | Class, def, type hint | from/import | class, def, assign | Stable |
| TypeScript | 11 tests | 6 tests | Interface, type, class | import { } from | interface, type, class, enum | Stable |
| JavaScript | 9 tests | — | Class, function, JSDoc | import/require | class, function | Stable |
| Java | 9 tests | — | Class, interface | N/A | class, interface | Stable |
| Go | 9 tests | — | Struct, interface, func | N/A | type struct/interface | Stable |
| Rust | 9 tests | — | Struct, impl, fn | N/A | pub struct/enum/fn | Stable |
| Dart | 9 tests | — | Class | import | class | Stable |
| C++ | 2/9 | — | Class, struct | N/A | class, struct | LS init slow |
| C# | 4/9 | — | Class, interface | N/A | class, interface | LS init slow |
