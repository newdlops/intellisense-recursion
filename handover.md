# Handover: hover/drilldown regression

작성 시점: 2026-05-23 KST

## 목표

VS Code editor native hover를 기반으로 한 symbol drilldown 흐름을 복구한다. 특히 다음 조건을 만족해야 한다.

- editor에서 `cmd+click`으로 갈 수 있는 symbol은 hover panel 안에서도 drilldown 대상이어야 한다.
- hover panel은 실제 native hover 위치와 내용으로 떠야 하며, 별도 테스트용 흰 DOM이나 fake hover로 통과하면 안 된다.
- drilldown 후에는 이전 hover 내용, stale sash/handle, 빈 hover shell, native hover와 custom hover가 겹치는 UI가 남으면 안 된다.
- 큰 hover에서 작은 hover로 전환해도 크기/스크롤/뒤로가기 위치가 깨지면 안 된다.
- 다중 column에서 한쪽 hover가 다른쪽 column hover/intellisense를 망가뜨리면 안 된다.
- E2E는 1회 성공이 아니라 반복 hover, drilldown, native popup 이후 hover, column 전환 후 hover까지 내구성을 봐야 한다.

## 현재 상태

최신 관찰 기준으로 문제는 stale content 재사용에서 한 단계 더 좁혀졌다.

- 이전에는 `Company` hover shell이 `BaseModel` hover 시점에 다시 살아나서 stale `Company` 내용이 보였다.
- hidden non-empty native hover root를 identifier mismatch일 때 제거하도록 바꾼 뒤 stale `Company` 재표시는 사라졌다.
- 현재 최신 실패는 `BaseModel` hover에서 provider probe는 `BaseModel` 내용을 반환하지만, DOM에는 숨겨진 빈 native hover shell만 남고 실제 hover가 뜨지 않는 `missing-hover`다.

최신 E2E 실패 요약:

```text
symbol: BaseModel
reason: missing-hover
rawHoverRoots:
  className: "monaco-hover fade-in hidden"
  textLength: 0
  rect: 0x0
provider probe:
  expected BaseModel markdown exists
missingExpectedTextFragments:
  "class BaseModel", "def save"
absentTextFragments:
  "class Company", "STATUS_ACTIVE"
```

즉 현재 상태는 "틀린 이전 hover가 보이는 문제"는 줄었고, "native command/refire 이후 빈 placeholder만 남고 실제 hover fill이 안 되는 문제"가 남아 있다.

## 최근 변경

주요 변경 파일:

- `src/extension.ts`
- `src/test/suite/hover.test.ts`
- `src/test/runTest.ts`

`src/extension.ts` 변경 핵심:

- `irPickReusableNativeHoverTarget(identifier)`에서 active visible native hover shell은 재사용하지 않도록 했다.
- native hover fallback reuse는 released/hidden/collapsed shell 중심으로 제한했다.
- `scheduleRendererNativeHoverFallback(...)`에 stale preview state, stale anchor, cooldown 체크를 넣었다.
- `window.irShowHoverFallback`에서 stale pointer, pointer-inside-hover, token mismatch, missing pointer token을 거부하도록 했다.
- `first`, `pos-cache`, `native-only` source에서는 `irApplyFallbackIntoReusableNativeHover`를 비활성화했다.
- hidden non-empty native hover root가 현재 identifier와 맞지 않는 내용을 갖고 있으면 reset이 아니라 제거/quarantine하도록 바꿨다.
- external hover artifact 탐지에서 VS Code workbench split/sidebar/panel scrollable을 hover artifact로 오탐하지 않도록 제외했다.
- hover sash metrics에서 decorations overview ruler나 hover 외부의 global sash를 제외했다.
- keybinding recorder 탐지를 더 좁혀서 실제 editor/native edit context를 recorder로 오탐하지 않게 했다.
- `cleanupNativeHoverInteractionStateForTests`에서 hidden empty native shell은 release-mark 하지 않고 그대로 보존하도록 바꿨다.
  - 이유: 빈 placeholder를 `ir-native-released-hover`로 표시하면 다음 native hover fill을 막는 것으로 보였다.

`src/test/suite/hover.test.ts` 변경 핵심:

- native hover geometry 검사에서 visible hover root, content match, stale content, empty shell, external artifact, sash alignment를 더 엄격히 보도록 확장했다.
- keybinding recorder recovery가 실제 editor를 닫지 않도록 `closeAllEditors` 경로를 제거했다.
- recorder 판정은 prompt text와 line count 조건이 맞을 때만 인정하도록 좁혔다.
- golden pass는 `Company -> BaseModel` 등 반복 hover/drilldown 내구성을 보는 방향으로 확장 중이다.

## 실행한 검증

컴파일:

```bash
npm run compile
```

여러 번 통과했다.

주요 E2E:

```bash
env IR_E2E_FILES=hover.test.js IR_E2E_GREP="actual native hover survives repeated drill-downs and native popups" npm test
```

관찰된 실패 흐름:

1. `Company -> get_owner`, `BaseModel -> save`, `TimestampedModel -> BaseModel` 구간까지 진행된 뒤, 나중에 `Company` 재방문에서 hover rect가 `2x0` 비슷하게 collapse된 적이 있었다.
2. reusable native hover shell injection을 막은 뒤에는 `BaseModel` 위치에서 stale `Company` 내용이 보였다.
3. hidden non-empty mismatch root 제거 후 stale `Company`는 사라졌지만, `BaseModel` 위치에서 visible hover가 아예 뜨지 않는 `missing-hover`가 남았다.
4. hidden empty shell을 release-mark하지 않도록 바꾼 최신 패치 이후에도 E2E는 `BaseModel`에서 `missing-hover`로 실패했다.

최신 실패에서 중요한 로그 포인트:

```text
native hover renderer-pointer request result -> BaseModel:
  ok: true
  reason: pointer-events-dispatched
  hoverCount: 0
  rawHoverRoots[0]:
    className: "monaco-hover fade-in hidden"
    textLength: 0
    visible: false
    released: false

native hover focus retry result -> BaseModel:
  command: editor.action.showHover
  ok: false
  reason: missing-hover

native hover focus retry result -> BaseModel:
  command: workbench.action.showHover
  ok: false
  reason: missing-hover

native hover focus retry result -> BaseModel:
  command: editor.action.showDefinitionPreviewHover
  ok: false
  reason: missing-hover
```

## 현재 의심 지점

가장 가능성이 높은 지점은 native hover shell lifecycle이다.

- renderer pointer event와 hover command는 호출된다.
- provider probe는 expected markdown을 반환한다.
- DOM에는 `.monaco-hover.fade-in.hidden` 빈 shell이 존재한다.
- 하지만 VS Code native hover controller가 그 shell을 fill/show하지 않는다.

현재 막힌 부분은 "provider는 살아 있고 native command도 실행되지만 native DOM materialization이 되지 않는 상태"다.

주의할 점:

- stale non-empty shell을 재사용하면 다시 이전 symbol 내용이 보일 가능성이 크다.
- 모든 VS Code sash/handle을 지우는 방식은 금지해야 한다. hover에 속한 sash만 다루거나, hover sash 자체를 붙이지 않는 방향이어야 한다.
- 테스트용 DOM이나 fake hover를 workbench 전체에 뿌리면 live 작업 창까지 망가진다. 테스트 DOM은 반드시 intellisense-recursion E2E window/test renderer에만 국한해야 한다.

## 다음 수리 방향

1. 최신 E2E 로그에서 `BaseModel` provider 결과가 반환된 직후 native hover controller가 왜 shell을 fill하지 않는지 로그를 더 붙인다.
   - pointer target
   - active editor identity
   - active hover controller command 결과
   - raw hover root 생성/삭제/hidden 전환 시점
   - provider result와 DOM fill 사이 시간

2. 빈 hidden native shell이 있을 때의 controlled fallback을 검토한다.
   - source가 `first`, `pos-cache`, `native-only`이고
   - visible hover가 없고
   - 현재 identifier와 맞는 fresh provider markdown이 있고
   - stale non-empty shell을 재사용하지 않는 경우에만
   - 빈 native shell에 preview markdown을 주입하거나 native hover 구조를 새로 구성한다.

3. 위 fallback을 넣는다면 `irApplyFallbackIntoReusableNativeHover`의 과거 방식으로 돌아가면 안 된다.
   - non-empty mismatched shell은 절대 재사용하지 않는다.
   - collapsed/stale shell에 내용을 덮어쓰지 않는다.
   - 실제 hover rect와 symbol anchoring을 E2E에서 바로 검증한다.

4. E2E golden pass는 다음을 계속 강제해야 한다.
   - `BaseModel` hover에서 `class BaseModel`, `def save`가 보인다.
   - 같은 hover에서 `class Company`, `STATUS_ACTIVE`가 보이면 즉시 실패한다.
   - visible hover root가 1개여야 한다.
   - empty hover shell이나 native/custom 중첩 hover가 symbol 근처에 보이면 즉시 실패한다.
   - hover sash/handle이 hover rect 밖 또는 stale 위치에 남으면 실패한다.
   - 반복 hover와 drilldown 후에도 같은 검사를 반복한다.

## 작업 시 주의

- 현재 worktree는 이미 dirty 상태다. 관련 없는 변경을 revert하지 말 것.
- `.codeidx/mcp-server.json`, `.lh/package.json.json`, `.vscode/.auto-import-cache/index.bin`, `log.txt` 등은 이번 hover 수정과 직접 관련 없는 변경 또는 생성물일 수 있다.
- `src/extension.ts`에는 큰 변경이 많이 들어가 있으므로, 다음 작업자는 `git diff src/extension.ts`를 먼저 훑고 hover lifecycle 관련 변경만 건드리는 것이 안전하다.
- E2E는 실제 native hover DOM을 봐야 한다. 왼쪽 상단 테스트용 흰 박스나 fake fallback을 golden pass로 인정하면 안 된다.

## 빠른 재현 명령

```bash
npm run compile
env IR_E2E_FILES=hover.test.js IR_E2E_GREP="actual native hover survives repeated drill-downs and native popups" npm test
```

현재 기대 결과는 pass가 아니라 `BaseModel`에서 `missing-hover`가 재현되는 것이다. 다음 수정 후에는 이 지점이 먼저 바뀌는지 확인해야 한다.
