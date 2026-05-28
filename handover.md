# Handover: hover pillar + hover position + UI border — L48~L61

작성 시점: 2026-05-28 KST (저녁)

## 목표

VS Code editor native hover의 잔존/위치/시각 회귀를 진단하고 안전한 fix를 적용한다.

- **세로 기둥(width 16px) 또는 가로 줄(height 2px) 모양 wrapper**가 dismiss 후 visible로 남으면 안 된다.
- 정상 hover의 transient initial paint(VS Code가 이전 활성화 dimension으로 한 frame 그리는 단계)는 죽이면 안 된다.
- 몇 번 hover 후 hover 자체가 안 뜨는 회귀가 재발하면 안 된다.
- hover 창이 **커서가 보고 있는 심볼을 덮거나 처음 떴을 때 심볼에서 멀리** 뜨는 회귀는 진단하고, **우리가 임의로 reposition 하지 않는다**. 드릴 hover는 의도적으로 mouse anchor 사용.
- hover 배경이 editor 배경과 시각적으로 구분되도록 border가 있어야 한다 (light/dark theme 둘 다).
- production log에는 fix 발동 audit trail만 남기고, 진단용 30-필드 dump는 default로 끈다.
- E2E golden pass가 pillar/bar 시나리오(stuck cleanup + transient 보존)를 회귀 보호한다.

## 현재 상태

stable. L61 빌드 이후 우리 코드 책임의 회귀는 0 (drill의 의도된 mouse-anchor 제외). 남은 hover-position-anomaly 13건/5분(2.6/min)은 모두 VS Code 자체 positioning — 우리가 직접 fix하지 않음.

핵심 검증 (L61 빌드 후 ~5분 세션):

- `hover-position-anomaly`: 13건 (covers-cursor 12, far-from-cursor 1)
- **`wrapPositionedOnce`**: 13/13 false → **모두 VS Code 자체** (drill false positive 제거됨)
- `column-wrapper-detected`: 2건, `cleaned`: 1건 — pillar fix 정상
- `force-preview-cleanup`: 3건 — A-cleanup 정상
- 사용자 회귀 보고: drill 정상, 첫 hover의 covers/far는 VS Code 자체

## 완료한 작업 (L48~L61 + E2E)

### Pillar/empty hover 회귀 (L48~L55) + E2E

| Patch | 내용 | 파일 |
|---|---|---|
| **L48** | `irResetWrapperPositionState` 강화 — height/maxHeight + ir-drill-hover class + inner monaco-hover style 정리 | `src/extension.ts` (~line 11083) |
| **L49** | `skip unrenderable hover root` 진단. L55에서 retire | (retired) |
| **L50** | `force preview hover visible failed` 진단. L55에서 retire | (retired) |
| **L51** | A) force-preview-failed root keepalive cleanup. B) inactive sweep loop에 column-wrapper detection fold (width<60 && height>40) | `src/extension.ts` (~line 15200) |
| **L52** | column-wrapper-cleaned 발동 (당시) display:none + ir-stale-hover → 호버 안 뜸 회귀 야기 | (수정됨) |
| **L53** | cleanup 안전화 — 2-pass gate(200ms), action 약화(inner class만, wrapper 안 건드림) | `src/extension.ts` (~line 15967) |
| **L54** | 가로 줄(bar) detection 추가(height<20 && width>200). force-preview-cleanup 500ms 2-pass gate | `src/extension.ts` (~line 15920) |
| **L55** | 진단 force-log 정리 (unrenderable / force-preview-failed retire) | `src/extension.ts` (~line 10534) |
| **Refactor** | `irScanNarrowHoverWrappers` 별도 함수로 추출 + `testHooks.scanNarrowHoverWrappers` 노출 | `src/extension.ts` (~line 15782, 17020) |
| **E2E** | `runHoverRendererHarnessForTests`에 column/bar gate verification step. 새 test `pillar/bar wrapper 2-pass gate strips our keepalive (L48~L54)` | `src/extension.ts` (~line 4703), `src/test/suite/hover.test.ts` (~line 5045) |

### Hover position 진단 (L56~L57, L59, L61)

| Patch | 내용 |
|---|---|
| **L56** | `hover-position-anomaly` 진단 force-log 추가 — active-switch 시점 mouse pos + wrapper rect 비교, covers-cursor (mouse inside wrap) / far-from-cursor (>150px) 분류 |
| **L57** | A) covers-cursor reposition fix (mouse.y+24px). B) far gate 150 → 80px. → L59에서 A revert |
| **L59** | L57의 하드코딩 reposition 제거 — 11/11 covers-cursor가 VS Code 자체, 우리 override가 anchor 의도와 항상 일치하지 않음. 진단만 유지. `hover-position-fixed` kind retire |
| **L61** | 진단에서 drill wrapper 제외 — `ir-drill-hover` / `__irDesired` / `__irPositionedOnce` 중 하나라도 있으면 skip. drill의 mouse anchor는 의도된 동작 ([[feedback_mouse_anchored_drill]] memory rule) |

### UI 시각 개선 (L58, L60)

| Patch | 내용 | 위치 |
|---|---|---|
| **L58** | `.monaco-resizable-hover`에 1px solid border (var(--vscode-editorHoverWidget-border) fallback chain) + border-radius 3px | `src/extension.ts` (~line 10358) |
| **L60** | 2px로 확대 + fallback chain `focusBorder` 우선으로 (theme별 강조 색). border-radius 4px | 동일 |

## 핵심 진단 데이터 (history)

### Pillar 패턴 (L51~L54)

```
column 모양: wrapRect w=16, h=181~648  inner: ir-keepalive ir-sticky ir-scrollable
bar    모양: wrapRect w=680, h=2       inner: ir-keepalive ...
wrapPositionedOnce=false  ← VS Code가 wrapper width:16px inline set, 우리 안 만짐
inner에 우리 keepalive 잔존 → sweep prune 막힘 → visible로 영구 잔존
```

### Hover position anomaly 패턴 (L56~L61)

```
covers-cursor 대다수: wrap.x = anchor token x (일정), mouse.x는 다른 token (200-400px 차이)
                     wrap.width=670 → mouse 흡수 → covers
dy (mouse.y - wrap.y) 두 cluster: ~190 (h/3), ~285 (h/2)
mouse type: pointerover (12/12) → 새 token으로 이동 직후 활성화
모두 wrapPositionedOnce=false → VS Code 자체 positioning
```

= 사용자가 mouse를 token A→B로 빠르게 이동 시 wrap-left는 A 기준 + mouse는 B 위 → cursor 덮음. VS Code의 native 동작.

### Drill의 의도된 mouse-anchor (memory rule)

drill-down hover (`ir-drill-hover` class)는 의도적으로 mouse가 wrapper upper-third에 위치 (line ~11577). 사용자가 link 클릭 후 micro-mouse-moves로 bbox 벗어나지 않게 하기 위함. [[feedback_mouse_anchored_drill]] 에 saved.

## 진단 force-log 정책 (L61 시점)

`IR_HE_FORCE_LOG_KINDS` + `IR_HE_FORWARDED_KINDS` 등록 kind:

**유지** (production audit trail):

- `force-preview-cleanup` — A-cleanup 발동
- `column-wrapper-detected` — pillar/bar 발견 (shape: "column" | "bar")
- `column-wrapper-cleaned` — 2-pass cleanup 발동 (ageMs)
- `wrapper-state-reset` — L48 reset 발동
- `hover-position-anomaly` — covers-cursor / far-from-cursor 진단 (drill 제외)
- 기타 drill/back-restore 등

**Retired** (회귀 재발 시 재추가):

- `unrenderable-hover-diag` (L49 → L55 retire)
- `force-preview-failed-diag` (L50 → L55 retire)
- `hover-position-fixed` (L57 → L59 retire)

## E2E 새 test

`src/test/suite/hover.test.ts` Hover Renderer E2E suite에 추가:

- `test('[python] pillar/bar wrapper 2-pass gate strips our keepalive (L48~L54)')`
- 시나리오 3종:
  1. column 안정 stuck (width 16 × height 180) → scan → 250ms 대기 → 두 번째 scan → keepalive 제거 검증
  2. bar 안정 stuck (width 680 × height 2) → 동일 흐름 (L54 가로 줄 검증)
  3. transient column → 한 번 scan → 즉시 dismiss → keepalive 보존 검증 (L53 회귀 보호)
- 격리: `hooks.scanNarrowHoverWrappers(reason)` 만 호출 (sweep 전체 안 함)
- harness가 inline style을 `setProperty(..., 'important')`로 강제해 VS Code의 `.monaco-resizable-hover` CSS rule이 dimension override하지 않게 함

## UI border 정책 (L60 시점)

`.monaco-resizable-hover`에 적용:

```css
border: 2px solid var(--vscode-focusBorder,
                     var(--vscode-editorHoverWidget-border,
                                  rgba(128,128,128,0.85))) !important;
border-radius: 4px !important;
```

- 2px stroke (L58 1px는 light theme에서 안 보임)
- `focusBorder` 우선 → theme별 강조 색 (보통 파랑 계열)
- box-sizing:border-box, 680px width budget에 흡수

## 빠른 재현 명령

```bash
# 컴파일/빌드
npx tsc -p ./ --noEmit
npm run bundle

# E2E (pillar/bar gate test만)
IR_E2E_GREP="pillar/bar wrapper" npm run test:python
# 기대: 1 passing, "column/bar gate: col[clean=true], bar[clean=true], trans[preserved=true]"

# 진단 force-log 확인 (live session log.txt 분석)
awk -v s="<activate-line>" 'NR>=s' log.txt | grep -c "hover-position-anomaly"
awk -v s="<activate-line>" 'NR>=s' log.txt | grep -c "column-wrapper-detected"
```

## 작업 시 주의 (memory rules)

`/Users/lky/.claude/projects/-Users-lky-project-intellisense-recursion/memory/` rule 두 개가 hover 코드 만질 때 적용:

1. **Dedup before paint** (`feedback_dedupe_before_paint.md`) — hover/preview 최적화 시 dedup 결정이 paint 전에 끝나야 함. paint 후 dedup하면 인터페이스가 갑작스럽게 변하는 것처럼 보임.
2. **Mouse-anchored drill** (`feedback_mouse_anchored_drill.md`) — drill hover의 wrapper position을 firstAnchor / wrapper rect에 lock하면 안 됨. mouse-based positioning은 의도된 사항. **L57 하드코딩 reposition을 L59에서 revert한 이유와 직결**.

기타:

- `column-wrapper-detected/cleaned`의 200ms 2-pass gate는 의도된 안전장치. 짧게 줄이면 L52 회귀(호버 안 뜸) 재발 가능.
- `force-preview-cleanup`의 500ms 2-pass gate도 동일.
- bar detection threshold(`height<20 && width>200`)는 false positive 위험.
- inner의 우리 클래스(`ir-keepalive`/`ir-sticky`/`ir-scrollable`) 없는 wrapper는 cleanup 대상 아님. VS Code 자체 wrapper에 hands off.
- `hover-position-anomaly` 진단에서 drill wrapper 제외 (L61). drill의 covers-cursor는 의도된 동작.
- VS Code 자체 hover positioning의 covers/far 회귀는 우리가 override하면 부작용 (L57 → L59 revert 경험). 진단만 누적.

## 남은 회귀 (미해결)

| 회귀 | 빈도 | 상태 |
|---|---|---|
| 첫 hover가 cursor를 덮음 (VS Code 자체) | 2.4건/분 | 진단 중, 직접 fix 시 부작용 |
| 첫 hover가 심볼에서 멀음 (~80-150px 떨어짐) | 0.2건/분 | 진단으로 가끔 잡힘 |
| scroll-restore re-fire null anchor error | 드물게 1건/세션 | 별도 issue, hover position과 무관 |

VS Code 자체 positioning의 어디서 (anchor source, hover controller layout) 잘못되는지 정확히 파악하기 전까지 진단만 누적.

## 컴파일/빌드

```bash
npx tsc -p ./ --noEmit   # type check만
npm run bundle           # tsc + esbuild 둘 다
```

L48~L61 + E2E 반영 모두 type-check + bundle 통과 확인됨.
