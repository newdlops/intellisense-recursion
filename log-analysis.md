# log.txt 분석 (hover 렌더링 엔진)

- **대상**: IntelliSense Recursion v0.2.58 renderer 로그 (`log.txt`)
- **구간**: 2026-05-30 00:59:57 ~ 01:18:31 (약 18.5분)
- **규모**: 2,398줄, 전부 `[info]` (에러/워닝 레벨 없음 — 실패가 info 안에 숨어 있음)
- **창**: w=5 (1,245줄), w=1 (705줄), w=3 (67줄)

## 이벤트 빈도 (상위)

| 이벤트 | 건수 | 비고 |
|---|---|---|
| `native hover` (released/cleaned/sweep) | 314 | 라이프사이클 |
| `point-wrap reject` | 164 | hover 없음/대상 아님 |
| `lazy-hover content` | 109 | 콘텐츠 주입 |
| `hover-box-corners` | 103 | 사이징 |
| `scan-decision` (candidate/wrap) | 163 | 스캔 |
| `hover-stage-reveal` | 69 | **staging 공개 (아래 #2)** |
| `force preview … failed` | 28 | **드릴 실패 (아래 #1)** |
| `duplicate preview suppressed` | 30 | **dedup (아래 #3)** |
| `hover-position-anomaly` | 12 | **위치 이상 (아래 #4)** |

---

## 🔴 #1. Drill 프리뷰 28번 전부 실패 — `force preview … zero-rect` (회복 0건) ✅ 수정됨 (L78, v231)

가장 심각. 재귀 드릴다운(hover 안 링크 클릭 → 다음 심볼 프리뷰)이 **28번 시도 전부 실패**, 성공 로그 **0건**.

```
force preview hover visible failed reason=zero-rect
  active={rect=0,0,0x0 textLen=57565 links=33 active=true renderable=false
          visibilityReason=zero-rect sample="Imported Symbol…Resolved symbol: zuzu…"}
```

- 콘텐츠는 정상 주입됨: textLen 131 ~ **57,566**, 링크 존재, `active=true`.
- **그런데 rect이 0×0** → hoverguard가 paint 차단.
- 코드 경로: `renderer-patch.ts:5944` `irHoverRootVisibility(root)`가 `visible=false` 반환 → `:5949` 실패 로그로 떨어짐.
- 회복 경로 `:5926`은 `remembered && rememberedFresh(<5s)`일 때만 동작 → **첫 드릴은 remembered rect이 없어 zero-rect로 그대로 실패.**
- 같은 타깃(`zuzu.db.models.company.company`, 57,565자)이 01:12:47 / 01:12:58 / 01:13:02 반복 = 사용자가 계속 재시도했지만 매번 빈 화면.

> 관련 메모리 `feedback_zero_rect_with_content_is_transient`("내용 있는 0×0은 transient, dispose 금지")는 **release만 막음**. force-preview 경로는 같은 0×0을 **hard-fail**로 처리 → "안 죽이지만 그리지도 못하는" 상태.

**확정된 근본원인** (로그 시퀀스 01:10:47):
1. hover가 풀사이즈(680×513)로 보이던 중 → 530개 타입 링크 re-wrap
2. 그 도중 `width-collapse-transition → 0×0` (단 `inlineW:"612px" hasDesired:true` = **높이만 transient 붕괴**)
3. `irForcePreviewHoverVisible`가 un-hide 후 측정한 진짜 0×0을 **hard failure로 반환**
4. revive 경로가 실패로 읽음 → `irDisposeHiddenActiveHover`(6180)가 `irReleaseNativeHiddenHover`로 **release** → 사용자에겐 "내용 사라짐"
5. L74 transient 보호(`__irZeroRectSkips`, 6170)는 **진입 시점 visibility가 `hidden-class`**라 `zero-rect` 매칭을 비껴감 → 28건 동안 **0번 발동** (`hidden-active-zero-rect-skip` 0건이 증거)

**적용된 수정 (L78, `renderer-patch.ts`, `RENDERER_PATCH_VERSION` 230→231)**:
- `irForcePreviewHoverVisible`(단일 choke point): un-hide 후 결과가 `zero-rect` + activating content면 hard-fail 대신 — bounded(≤10회) 동안 hover를 un-hidden 유지, `__irZeroRectTransientUntil`(250ms grace) 스탬프, `requestAnimationFrame`로 reflow 재확인 예약, `return true`. 성공 측정 시 카운터/grace 리셋.
- `irDisposeHiddenActiveHover`(release 직전): grace window 내 + content 있으면 release를 **hold**(`return false`) → transient가 VS Code relayout(~70ms)으로 자연 회복.
- 검증용 he-event `force-preview-zero-rect-transient`(phase=force-keepalive/dispose-hold) 추가 + force-log 허용목록 등록.

**런타임 검증법**: v231 재주입 후 드릴 → 로그에서 `force preview … zero-rect failed`가 사라지고 `he-event force-preview-zero-rect-transient`가 보이면 성공. 회복 못 하고 ≤10회/250ms 초과 시에만 기존대로 release.

**남은 리스크**: 다른 release 경로(MutationObserver/sweep)가 같은 transient를 죽이는지는 미확인 — 관측된 28건은 모두 `hidden-active-hoverguard`(6180) 경유라 커버됨.

### ✅ v231 런타임 검증 (2026-05-30 15:25~15:26 재캡처)

| 지표 | v230 | v231 |
|---|---|---|
| `hidden-active-hoverguard` release (버그 경로) | 다수 | **0건** |
| dispose-hold (release 차단) | — | 17건 |
| force-keepalive (un-hidden 유지) | — | 20건 |
| release 경로 | hoverguard(버그) | active-switch·prune(정상)만 |
| settled 안정 | — | 19/29, 드릴 11건 렌더 |

→ **transient-release churn 제거 확인.** release는 정상 생명주기로만 발생.

**단, 별개 선재 버그 노출 — 진동(oscillation):** 남은 hard-fail 8건은 skips가 `1~10 각 2건씩 완벽한 계단` = 2~3개 hover가 10회 retry 끝에 포기. transient가 아니라 **flicker**(예: `common.services` textLen=1225가 ~20초간 normal↔collapsed 반복). `width-collapse-transition`이 `rect:{0,0}`인데 `inlineW:"670px" inlineH:"177px"` → **wrapper 레벨 붕괴**. `inlineW:"16px"` 필러 붕괴도 v231 5건. 진동 비율은 v230(52/46)·v231(10/8) 동일 = **내 수정이 유발한 게 아닌 선재 버그.**

**한계**: L78 fix와 remembered-rect fallback 모두 `root`(.monaco-hover)에 스타일을 걸지만, 붕괴는 `wrapper`(.monaco-resizable-hover) 레벨 → root force-visible로 해결 불가. **다음 작업(#2 collapse churn)에서 wrapper 붕괴 소스를 잡아야 함** (style observer / resizable-hover 사이징).

---

## 🟠 #1-후속. Wrapper 붕괴 소스 추적 + 16px 필러 수정 (L79, v232)

v231 타임라인을 정밀 분석해 wrapper 0×0/16px 붕괴를 두 종류로 분리했다:

**(a) `rect 0×0` + `inlineW:"670px"` 유지 → 정당한 dismiss (버그 아님)**
실제 시퀀스: hover 위에서 pointerdown → 에디터의 *다른* 토큰 클릭 → `hide hover requested outside-editor-new-token` → 새 토큰 hover 표시. inlineW가 실폭(670)을 유지한 채 rect만 0 = VS Code가 잠깐 display 처리. msSincePointWrap도 수 초 간격(빠른 flicker 아님). L78이 이미 잘 처리(release 0건).

**(b) `inlineW:"16px"` 필러 → 진짜 버그 (사용자 보고 "pillar")**
`column-wrapper-detected`가 `wrapDisplay:"block" wrapVisibility:"inherit" innerTextLen>0` 캡처 = **display:none이 아니라 inline `width:16px`가 박힌 세로 슬리버**. 스타일시트 `min(max-content,680px)`를 inline 16px가 덮어써서 **스스로 복구 못 함**. v231 타임라인 증거 — 필러 stuck 지속시간:
```
08.701 → 14.187 normal   (5.5초)
18.148 → 23.636 normal   (5.5초)
32.234 → 48.966 normal   (16.7초!!)
```
기존 `irScanNarrowHoverWrappers`(6647)는 이 필러를 감지하지만 **우리 클래스만 제거하고 width는 복원 안 함** → 슬리버 그대로. (v231: detected 18 / cleaned 8)

**적용한 수정 (L79, `renderer-patch.ts`, v231→232)**:
- `irScanNarrowHoverWrappers`: 2-pass(≥200ms) 확정된 **콘텐츠 있는 column 필러**는 클래스 제거 대신 **stuck inline `width`/`min-width`를 1회 제거** → 스타일시트가 재확장. episode당 1회(`__irColumnWidthRestored`, style observer가 `to:normal`에서 리셋)로 VS Code와 프레임 단위 충돌 방지. 빈 shell·bar·1초 내 재붕괴는 기존 class-strip로 폴백. (top/left 재핀 아님 → L69의 v=221 position-loop 회귀 회피)
- 진단 보강: `width-collapse-transition`에 `inlineMinW/inlineDisplay/inlineVisibility` 추가, 신규 he-event `column-wrapper-width-restored`.

**검증 필요(인세션)**: v232 재주입 후 드릴 → 16px 필러가 즉시 정상폭 회복하고 `column-wrapper-width-restored`가 찍히는지, 그리고 width 진동/재붕괴 회귀가 없는지 확인. (L78과 달리 VS Code resize와 상호작용하므로 회귀 감시 필요)

---

## 🔴 #1-후속2. L80/L81 proactive width-freeze가 **무한 진동 루프** 유발 — 회귀, 원본보다 악화 (v234 재캡처) ✅ 수정됨 (L82, v235)

- **대상**: v234 renderer 로그(`log.txt`), **2026-05-30 18:10:46 ~ 18:11:29 (단 43초)**, 2,451줄.
- **이벤트 분포 (43초)**: `width-freeze` **1,019** (hold 510 / release 509, reason 전부 `content-ready`) + `width-collapse-transition` **1,020** (collapsed 510 / normal 510) = **2,039건, 로그의 83%**.
- = **~47 events/sec**, 단일 hover(`company_type.py`, innerTextLen 979)에서 **510 풀사이클**의 16px↔670px 진동(strobe). 사용자에겐 box가 미친듯이 떨림.

### 루프 메커니즘 (확정, seq 5664~ 첫 60줄로 직접 추적)
```
release content-ready(ageMs:9) → collapse to=collapsed(w16, inlineMinW:"")   ← 플로어 제거 → 재붕괴
hold w=670                      → collapse to=normal(w670, inlineMinW:670px)   ← 재freeze, 플로어가 폭 복원
release content-ready(ageMs:8) → collapse to=collapsed ...                     ← 8ms 뒤 또 release → 무한반복
```
1. collapse 감지(style-obs 1498 / reposition 2795·2938 / sweep 6824) → `irMaybeFreezeCollapsedWidth` → `irFreezeWidth`가 `min-width:670px !important` 박음 → wrapper rect 정상화, release 체크 rAF 예약.
2. `irScheduleWidthFreezeReleaseCheck`(L1388)가 ~8ms 뒤 inner `.monaco-hover` width≥60+text → `innerReady=true` → **즉시 release**(`removeProperty('min-width')`).
3. 플로어 제거 → wrapper의 `width:min(max-content,680px)`가 다시 16px로 계산(이 hover의 **지속성 필러** — transient 아님) → style-obs가 붕괴 감지 → 1번으로. **영원히 반복.**

### 근본원인: release 게이트가 구조적으로 항상 참
`innerReady` = **inner** `.monaco-hover` 폭≥60. 그런데 inner는 `width:max-content`라 wrapper가 16px든 말든 **자기 텍스트 폭(수백 px)을 늘 측정** → `innerReady`는 콘텐츠만 있으면 **항상 true**. 반면 필러는 **wrapper 레벨** 붕괴(`min(max-content,680px)`의 wrapper max-content가 16으로 계산). **inner 폭으로는 wrapper 붕괴를 감지 불가** → release가 매번 발사 → 플로어 제거 → 재붕괴. freeze/release는 핑퐁이 숙명.
- 안전장치 사망: `IR_WIDTH_FREEZE_MAX_MS=600` / `tries>40`(L1399)은 release가 8ms에 먼저 터져 **한 번도 도달 못 함**.
- `column-wrapper-width-restored`(L79 복원) **단 1건** — freeze 루프가 sweep 복원을 굶김.

### A/B 증거 — 같은 필러, 처리방식만 다른 두 창이 한 로그에 공존
| 창 | 버전 | 처리 | 결과 |
|---|---|---|---|
| `company_type.py` | **v234** | L80/L81 proactive freeze | **freeze 1019 + transition 1020, 510사이클 진동** |
| `run_usage_accuracy.py` | v230 | L79 reactive sweep | `column-wrapper-detected` 151 / `cleaned` 8, **진동 0** |

→ **두 창 모두 지속성 16px 필러를 겪지만, v230의 reactive sweep은 시끄럽되 안정적이고, v234의 proactive freeze는 파국적으로 진동.** L80/L81이 #1-후속 버그를 고치려다 **더 악화시킨 회귀.**

### 조치 (우선순위)
1. **[핵심] 진동 latch** — `irFreezeWidth`에서 직전 release로부터 ~120ms 내 재freeze면 `__irFreezeOsc++`; `irScheduleWidthFreezeReleaseCheck`에서 `__irFreezeOsc>=3`이면 **content-ready release를 중단(latch)**하고 dismiss/anchor-swap(L1588~1593 clear 경로)까지 플로어 유지. 지속성 필러를 **last-good 폭으로 고정** = 안정적 가독 박스(L80 본래 의도). latched freeze는 600ms cap 무시(사용자가 읽는 중).
2. **[보조] style observer 자기쓰기 가드** — freeze가 박는/지우는 min-width가 스스로 `width-collapse-transition`+재freeze를 유발(L1498). freeze/release 시 `__irFreezeWriting` 플래그 → 옵저버가 직후 mutation 무시(기존 `styleReapplyPending`과 동일 패턴). transition 스팸·CPU·즉시 재freeze 차단.
3. inner-width 게이트(L1396)는 wrapper 붕괴를 못 보므로 release 신뢰 근거로 부적합 — latch가 없으면 단독으로는 못 고침.

### ✅ 적용한 수정 (L82, `renderer-patch.ts`, v234→235)
**진동 latch 단일 수정.** 자기쓰기 가드는 의도적으로 제외 — 그게 있으면 style-obs 재freeze가 늦어져 latch가 빨리 못 걸림. 재붕괴(release 직후 즉시 collapse)를 **신호**로 삼아 transient와 persistent pillar를 구분.
- `irFreezeWidth`: 직전 release로부터 `IR_WIDTH_FREEZE_OSC_WINDOW_MS=80ms` 내 재freeze면 `__irFreezeOsc++`, 아니면 0. `osc>=IR_WIDTH_FREEZE_OSC_LATCH=3`이면 `__irFreezeLatched=true`. `width-freeze hold`에 `osc`/`latched` 필드 추가.
- `irScheduleWidthFreezeReleaseCheck`: latched면 **content-ready release 안 함** — `IR_WIDTH_FREEZE_LATCH_POLL_MS=250ms` 느린 poll로 전환, `IR_WIDTH_FREEZE_LATCH_MAX_MS=8000ms` backstop에서만 `reason=latch-timeout`으로 해제.
- `irReleaseWidthFreeze`: `__irLastFreezeReleaseAt` 스탬프 + `__irFreezeLatched=false`(재freeze가 latch 재평가).
- dismiss/clear 경로(L1591): 새 콘텐츠/앵커면 `__irFreezeOsc`/`__irFreezeLatched`/`__irLastFreezeReleaseAt` 리셋.
- **효과(예상)**: 510사이클 → **~3사이클(~24ms) 후 latch**. 2,039 이벤트 → ~13. box는 last-good 폭으로 **안정 고정**(L80 본래 의도). transient는 osc=0 유지 → 기존 동작 불변. persistent pillar는 8s마다 1회 blink 후 재latch(최악). 타입체크·compile 통과(v235 emit 확인).

**런타임 검증법**: v235 재주입 → 드릴/hover → 로그에서 `width-freeze hold`가 `osc:0~2` 3건 뒤 `latched:true`로 멈추고, `width-collapse-transition` 폭주(43초 2,039건)가 사라지는지 확인. `reason=content-ready` release가 초당 수십 건 → persistent 케이스에서 0건이어야 함.

> 관련 메모리 `project_repreview_churn_vscode_internal`("freeze width to make re-render invisible")의 freeze가 release 정책 때문에 진동기로 변질. `feedback_collapse_threshold_consistency`(width<60) 임계는 일관됨 — 문제는 임계가 아니라 release 조건.

---

## 🟠 #2. Hover 공개 최대 2.5초 — staging budget 40% 초과

```
hover-stage-reveal  settled : 41건 (avg 121ms)
hover-stage-reveal  budget  : 28건 (avg 680ms, max 2495ms)  ← 약 40%
```

- `renderer-patch.ts:1264` `IR_HOVER_STAGE_BUDGET_MS=500` (하드 실링)인데 **budget reveal이 500ms를 한참 넘겨 최대 2,495ms** 보고.
- 원인 추정: `:1279` `if(wrapperEl.__irStaging){…return;} // mid-session: keep budget clock` — 콘텐츠 스왑 시 budget 시계를 리셋하지 않고 누적.
- 결과: 40% 케이스에서 hover가 `visibility:hidden`으로 staged된 채 0.5~2.5초 지연 → 체감 굼뜸.

> 관련 메모리 `feedback_stage_hover_until_settled`의 500ms 예산이 사실상 지켜지지 않음.

**조치**: `:1279` 스왑 시 시계 유지 정책 재검토. budget reveal `ms`에 절대 상한(swap당 리셋 또는 hard cap)을 두어 2.5초 staged 방지.

---

## 🟡 #3. 같은 심볼 마이크로 무브에서 쿼리 13연발 — `duplicate preview handle=47`

01:11:59~01:12:08, `company-owner-app-context-query.ts` **line 18**에서 컬럼만 바뀌며(18:26→25→24→20→19→14→…→9→13) **동일 타입 `[OWNER_MENUBAR_FRAGMENT,…]` 쿼리 13번** 발사 → 전부 `duplicate preview suppressed … source=first`로 폐기.

- dedup은 정상 작동(메모리 `feedback_dedupe_before_paint`).
- 그러나 **upstream 쿼리 발사 자체가 컬럼 단위로 트리거** → 발사 후 폐기라 낭비.

> 관련 메모리 `feedback_anchor_moved_compares_range`, `feedback_suppress_same_symbol_refire`: 앵커 **word range**로 게이팅하면 발사 전에 차단 가능.

**조치**: same-symbol refire를 컬럼이 아닌 앵커 word range 비교로 query 진입 단계에서 가드.

(참고: dedup source 분포 — handle=47 first×13/inflight×1, handle=138 pos×5/inflight×5, handle=232 pos×3/first×2, handle=29 first×1)

---

## 🟡 #4. Hover 위치 이상 12건 — 커서 덮음 / stale 마우스

`hover-position-anomaly`:
- `covers-cursor` 7건: `distance=0, inside=true`, mouseAge 4~773ms — hover가 **가리키는 심볼을 덮음**.
- `far-from-cursor` 5건: 그중 2건은 `mouseAgeMs=96391`, `448277` (96초·448초 전 좌표) — **stale 포인터 기준 판정**.
- 공통: `wrapPositionedOnce:false, wrapHasDesired:false` 상태에서 발생.

**조치**: `mouseAgeMs`가 큰(>1s) 좌표는 anomaly 판정/위치 기준에서 제외.

---

## 권장 조치 (우선순위)

0. ~~**[🔴 최우선·회귀] L80/L81 width-freeze 무한 진동**~~ — ✅ **완료** (L82, v235). 진동 latch로 ~3사이클 후 고정. 위 **#1-후속2** 참조. **런타임 검증 대기**(v235 재주입 후 로그 재캡처).
1. ~~**[🔴 최우선] force-preview zero-rect 회복**~~ — ✅ **완료** (L78, v231). 위 #1 참조.
2. **[🟠] staging clock 상한** — `:1279` 정책 검토, budget `ms` hard cap.
3. **[🟡] same-symbol refire 발사 전 차단** — 앵커 word range 가드.
4. **[🟡] stale-pointer 가드** — `mouseAgeMs>1s` 좌표 제외.
