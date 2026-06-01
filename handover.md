# ★★ 네이티브 호버 전환 — 2026-05-31 세션 (HEAD db39c8a=v248 / 작업트리=v262, L89~L97) [최신·최우선]

## 목표 (사용자 지시)
overlay hover → **VS Code 네이티브 hover**로 전환. VS Code가 **size/position/resize/scroll/dismiss를 소유**. 우리 역할 = **content(프리뷰 markdown) + drilldown + cmd+click 링크**만. 나머지 관리 로직은 **삭제 금지 — deprecated 주석 + `IR_HOVER_NATIVE_ONLY` 게이트로 OFF**(나중 복원 가능). 드릴도 가급적 native(page-transition→$provideHover→native render).

## 마스터 스위치 2개
- `IR_VTAIL_MODE: 'native'|'overlay' = 'native'` (src/util.ts:118) — content 경로. native면 extension의 `irStashLargePreviewForChannelTest`가 overlay CDP 채널을 우회(full preview 그대로), preview-builder `renderPreviewCodeFences`는 head/tail split.
- `var IR_HOVER_NATIVE_ONLY=true;` (renderer-patch IIFE **최상단**, RENDERER_PATCH_VERSION 줄 아래 ~L32) — 렌더러 관리층 OFF. ⚠️ **CSS 배열(`style.textContent=[`)보다 위에서 "할당"** 필수 — CSS가 패치 로드 시 동기 실행하며 이 값을 읽음. var hoisting만으론 그 시점 undefined라 잘못된 분기를 탐. 함수 게이트들은 런타임 호출이라 선언 위치 무관.

## git 상태 (중요 — 세션 시작 시 먼저 처리)
- HEAD `db39c8a "native hover"` = **v248 커밋**(IR_VTAIL_MODE='native', extension native path, renderer-patch v248=L89 native-only).
- **작업트리 = v262 (L90~L97), 미커밋** — `src/renderer-patch.ts`(+92/-19), `src/preview-builder.ts`(head/tail split). **→ 먼저 커밋 권장**(안 하면 v262 작업 유실 위험).
- 백업: 브랜치 `backup/native-hover-drill-pre-reset-8a4ebda`, `stash@{0}`(reset 전 native v253).

## 버전/마커 히스토리
- v247: stash의 viewport-wrap을 8a4ebda 위로 포팅(24K 초과 big hover에서 드릴 링크 복구).
- v248 **L89**: native-only 스위치 도입. staging/keepalive/sticky/scrollable/freeze OFF. ← **HEAD 커밋**.
- v254 **L90**: scan storm 수렴 가드 — `block.__irViewportWrap=vpLimit&&wrappedCount>0`(새 wrap 0이면 해제) + 스크롤 시 `.rendered-markdown` 재무장. (wrap→MutationObserver→재스캔 무한루프 차단; plateau links 151×10이 증거였음)
- v255 **L91**: size CSS takeover 통째 제거 시도 → **balloon 32000px 회귀 → v256에서 되돌림**. 교훈: 캡 제거하면 풍선.
- v257 **L92**: head/tail split(native도 앞 120줄만 하이라이트 + 꼬리 plain fence) → **perf 6배↓ (longtask 총 29.7s→4.9s, max 1501→587ms)**. + CSS rule(.monaco-resizable-hover)에서 width/height의 `!important`만 제거(인라인 resize가 이기게)·sash 숨김 룰 native에서 해제(ternary).
- v258 **L93**: `irQuarantineHoverNativeHandle` OFF — JS가 `.monaco-sash`를 능동 격리해 CSS로 살린 핸들을 다시 숨기던 것.
- v259 **L94**: `irTypeLinkPointerDown`에서 sash pointerdown이면 early-return(dispose 방지) + `irIsBlockVisibleInHover`에서 0×0 stale(dismissed) hover skip(scan self-loop·CPU 누수 차단).
- v260 **L95**: mgmt OFF — `irAttachWrapperResizeReposition`(per-resize ResizeObserver), `irReleaseNativeHiddenHover`, `irDisposeHiddenActiveHover`, `irDisposeActiveHoverForEditorTarget`.
- v261 **L96**: 포괄 OFF — `irMarkNativeHoverReleased`, `irDisposeStaleHover`, `irRemoveInactiveHoverArtifacts`, `irScanNarrowHoverWrappers` (+ wheel guard 2개 — v262에서 되돌림).
- v262 **L97**: wheel guard 2개(`irHoverInternalWheelGuard`/`irPreviewTransitionWheelGuard`) **un-gate**(#4 회귀 수정) + `irReleaseNativeHoverManagement` gate(release↔revive flicker churn 차단).
- v263 **L98**: `irKeepHoverInViewport` no-op 스텁 → **네이티브 뷰포트 클램프** 재활성(통찰 #1 "불가피한 단 하나의 size 관리"). `.monaco-resizable-hover` 하단이 뷰포트 밖이면 **위로만** nudge(`style.top`=rect.top−overflow, top margin 8px 한계 내). placement 재계산·left·아래이동 안 함. **native 한정**(`if(!IR_HOVER_NATIVE_ONLY)return` — overlay는 irRepositionInitialHover가 clamp+`__irDesired` 소유). collapse(w<60‖h<20) skip, 멱등(`overflow<2` slack + `prevTop===newTop`, 한 스텝 수렴). 드릴은 layout-wrap이 `__irDesired.top` 재적용하므로 그것도 갱신. 스캔 루프 가시성 게이트 직후 와이어. force-log kind `hover-viewport-clamp`. **v263 라이브: clamp 0회 = 정상**(이 세션 호버는 host가 캡되어 화면 안; balloon은 콘텐츠 .rendered-markdown 3168px지 wrapper 아님). 실제 통증은 off-screen이 아니라 scan storm → L99.
- v264 **L99**: **scan storm 근본 fix** (사용자: "스크롤 원활X + 긴 콘텐츠 스크롤 멈춤"). w=6 v=263 로그(18:09:56~18:10:03): 57623자 호버가 **7.6초간 94회 재스캔**(`viewport-wrap text=57623` ×94, links 0→367+ 단조증가). 원인 = **자기유발 루프**: 우리 `.ir-type-link` span 삽입 → `__irMarkdownObserver`(`document.body` childList/subtree)가 `.rendered-markdown` 안 변경 감지 → `seenScan=true` → `irScheduleScan` → 재스캔이 **57K 전체 재처리**(textContent + candidate 57379 + 206-type regex) + span 몇 개 더 → 무한. L90 수렴(`__irViewportWrap=vpLimit&&wrappedCount>0`)은 progressive wrap이라 94패스 동안 wrappedCount>0 유지돼 안 멈춤. 콘텐츠가 휠 밑에서 계속 reflow = "멈춘 것처럼". **fix: `irIsOwnLinkWrapMutation(mut)`**(childList + added 전부 text-or-`.ir-type-link` + removed 전부 text)면 observer 콜백이 그 mut을 `continue` skip → 자기유발 재스캔 0. 진짜 콘텐츠 swap(element subtree)·스크롤(`irEnsureHoverScrollListener`가 `__irViewportWrap` 재무장+`irScheduleScan`)에서는 스캔 유지 → newly-visible 행 wrap 보존. **검증지표(새 로그 불필요)**: 큰 호버 1개당 `viewport-wrap text=5XXXX` 횟수가 ~94 → 한 자릿수.
- v264 **라이브 실패** (w=6 v=264, 18:44~46): 57314자 호버 viewport-wrap **95회**(~50ms 간격 burst, 거의 그대로). 원인 = `irIsOwnLinkWrapMutation`의 **버그**: wrap의 `span.appendChild(matchedText)`는 부모에서 텍스트가 **빠지는** mutation(added=[], removed=[text])을 만드는데, `if(!added.length)return false`가 이걸 "우리 것 아님"으로 처리 → 매 스캔 seenScan 세팅(added-record skip이 무의미). → v265에서 수정.
- v265 **L99-fix + L100**: (a) **storm fix 수정** — `irIsOwnLinkWrapMutation`가 제거 레코드도 처리(added 비어도 removed가 전부 text|ir-type-link면 우리 wrap). 스캔이 매 패스 부르는 geometry/pointer/back-button은 노드 add/remove 안 함(attr/멱등) 확인 → 유일 연속 childList=우리 wrap. (b) **L100 관리층 deprecate**(사용자 "overlay 철저히 deprecate"): v264 churn = `irScheduleManagedHoverVisibilityKeepalive`(22× visibility-keepalive 타이머) → `irReviveRecentlyManagedHover`(VS Code가 invisible化한 호버 되살림=dismiss와 싸움). **둘 다 `if(IR_HOVER_NATIVE_ONLY)return` 게이트**. force-preview(drill-apply)·9391 released-marking↔6657 revive(wrapper 재사용 보호 [[project_single_hover_wrapper]])는 drill 인프라라 **보존**. **v265 배포·설치 완료, 재시작 후 검증 대기**(storm 횟수↓ + 스크롤 smooth + **드릴 여전히 작동?**(revive 게이트라 native re-hover 의존 — 깨지면 visibility-keepalive가 drill에 load-bearing이었던 것)).
- v265 **라이브 결과**: visibility-keepalive 0✓·revive 0✓(L100 작동) BUT storm 여전(57623→78×, 57314→51×) + **released-revive 23× 잔존**. w=6 v=265 19:06~09 시퀀스 분석: 콘텐츠 len이 **57638↔59293 진동**(가끔 114952=중복) → VS Code가 거대 프리뷰 반복 토크나이즈(**longtask 최대 1603ms**) + 진동이 storm 재스캔 구동. `released native hover revived`(6657)가 진동과 1:1 상관 → **내가 보존한 9391↔6657 release-revive가 churn·진동·(재사용 wrapper stuck-hidden=짧은 호버 안보임)의 공통 원인**으로 판명. host 173px도 진동 중 측정 artifact 의심. clamp 0회=정상(host bottom 화면 안, off-screen 아님).
- v266 **L101**: **마지막 ungated release writer 게이트**. 9391 else-branch(detached/재사용 root를 hidden+`ir-native-released-hover` 마킹)를 `else if(!IR_HOVER_NATIVE_ONLY)`로 native에서 차단. released-attr 세터는 4504(irMarkNativeHoverReleased, 게이트됨)+9391 둘뿐 → **native에서 release 상태 0** → revive/skip-unchanged 서브시스템 전체 inert. 기대효과: (a) release-revive churn 0, (b) 콘텐츠 진동·storm·longtask↓(진동이 revive 구동이었다면), (c) **짧은 호버 stuck-hidden 해소**(재사용 wrapper가 released로 안 남음). drill 정리의 removeChild(if-branch)는 보존. **v266 라이브**: 일부 개선(57314 storm 51→2, unrenderable-active 0, longtask 29→16/1603→1164ms, revive 23→13) BUT 57623 storm 65× 여전(tight 40ms 루프) + 콘텐츠 진동(57638↔59293) 잔존 + release-revive 13×.
- v267 **L102 (extension-side, 사용자 승인)**: **VS Code 재렌더 churn 근본 fix**. 조사 결과(extension `[hover] attach native=326 ours=58997` 반복이 증명) = VS Code가 intra-word 마우스 드리프트마다 `$provideHover` 재호출 → extension 재attach → 58997자 재렌더(1164ms 토크나이즈 + renderer storm). 근본원인 = `hoverRequestKey=uri:line:**char**`(extension.ts ~1587)로 **모든 hover dedup이 정확한 글자 위치 keyed** → drift가 새 키 → dedup 우회. renderer L71([[feedback_anchor_moved_compares_range]]: range-not-column)과 동일 버그의 extension판. **fix**: `deliveryGroupKey`(1780)와 `hoverPreviewPrimaryHandleAllowed` 키(1796)를 exact `hoverRequestKey` → **word-anchored `posKey`**(=`hoveredCandidate.anchor`=단어 시작, drift에 안정)로 변경. drill 매칭(1604, 컴포넌트 직접)·fallback(1704)·suppress(1732/1738)는 보존. RENDERER_PATCH_VERSION 267로 마커 bump(extension-only 변경이라 renderer 로그 구분용). 빌드/주입/번들/배포 OK(두 변경 out/extension.js 확정). **재시작 후 검증 대기**: 57623 viewport-wrap 횟수↓·진동 소멸·longtask↓. 메모리 [[project_hover_rerender_exact_position_key]].
- v267 **라이브 실패**(20:20~24): storm 더 심함(57623→82×), 진동 지속(58984↔59948↔58269), longtask 637ms. L102가 안 통한 이유 = primary 핸들이 deliverablePreviews 비어도 1551에서 `previews`(full) 재attach → word-keying이 primary의 full 재attach를 못 막음. **사용자 핵심 관찰**: extension `attach native=0/158/326 ours=58997/59221` — VS Code의 native LSP hover는 0~326자(거의 빈 것)인데 우리는 58997자 주입. **VS Code가 hover 높이를 host=666x173 또는 666x246(VS Code 내부 max ~252px, L298)으로 잡음 = 우리 콘텐츠(3168px)와 매칭 안 됨.** native가 변하니(0/158/326) 우리 dedup도 변동(58997 1블록/59221 2블록)→진동. 추측 fix(L98~102) 다수 실패 → 측정 우선으로 전환.
- v268 **L103 (진단)**: `irAuditHoverSize` 추가 — 활성 큰 호버(contentLen≥400)의 **wrapper rect h / host h / scroller h / scrollHeight / clientHeight / maxTop / wrapInlineH** 를 force-log(`hover-size-audit`, 1s/host throttle). 목적: scroller h > wrapper h(=스크롤 썸이 밑으로 빠짐) 인지, maxTop=0(스크롤 불가)인지, VS Code wrapper 높이 vs 우리 콘텐츠 정확 측정 → 추측 없이 사이징 fix. **재시작+Company 호버 후 `grep hover-size-audit log.txt` 읽고 정밀 fix 결정.**
- v268 **측정 결과 (근본 원인 확정)**: `hover-size-audit` — 큰 호버 `wrapH:250 hostH:246 scrollerH:511 scrollH:30172 maxTop:29661 wrapInlineH:"250px"`; 짧은 호버 `wrapH:177 scrollerH:382 scrollH:382 maxTop:0`. **스모킹건: scrollerH(511) > wrapH(250)** — VS Code는 resizable wrapper를 DEFINITE 인라인(~177/250px, 자기 기본 크기)로 잡는데, 우리 `.monaco-hover{height:auto}`(line 323)는 INDEFINITE라 자식 `.monaco-scrollable-element`의 `height:calc(100%-2px)` 퍼센트가 안 풀려 → `max-height:48vh`(511)로 떨어짐 = wrapper와 무관하게 511px scroller → 스크롤바가 wrapper(250) 바닥 아래로 빠짐("썸 안 보임"). 짧은 호버는 scroller=content=382 > wrapper=177 + maxTop=0 → 바닥 205px가 wrapper 밖인데 스크롤도 안 됨("짧은 내용 안 보임"). 사용자 직감(우리 주입이 scroll 높이 교란) 정확 — 단 범인은 drill 컨트롤이 아니라 height:auto CSS.
- v269 **L103-fix**: `.monaco-hover{height:auto→100%}`. wrapper 인라인 px(definite)에 대해 풀려 scroller=wrapper-2 → 큰 호버 썸 일치 + 짧은 호버 maxTop>0(스크롤 가능). max-height:48vh는 formation-time(인라인 미설정 시) fallback 캡으로 유지. size-audit 진단 유지(효과 확인용). **재시작 후 검증**: `hover-size-audit`에서 scrollerH≈wrapH, 짧은 호버 maxTop>0; 육안 썸 일치+짧은 호버 끝까지 보임/스크롤됨.

## 현재 OFF — 16 게이트 (`if(IR_HOVER_NATIVE_ONLY)return...` + "DEPRECATED" 주석)
irStageHover · irFreezeWidth · irAttachWrapperResizeReposition · irRepositionInitialHover · irArmHoverSticky · irMarkNativeHoverReleased · irReleaseNativeHoverManagement · irMarkHoverManaged · irDisposeActiveHoverForEditorTarget · irQuarantineHoverNativeHandle · irReleaseNativeHiddenHover · irDisposeHiddenActiveHover · irScanNarrowHoverWrappers · irRemoveInactiveHoverArtifacts · irDisposeStaleHover · irMakeHoverScrollable. + CSS ternary: resizable-hover width/height 핀 제거 · sash 노출.

## KEPT (우리 역할)
- **content**: extension `$provideHover` 패치가 `res.contents`에 우리 markdown 첨부 → VS Code 네이티브 MarkdownRenderer 렌더. preview-builder `renderPreviewCodeFences` = head 120줄 하이라이트 + 꼬리 plain fence(언어태그 없음=토크나이즈 0).
- **drill/cmd+click**: `irScanRenderedMarkdown`의 링크 wrap(.ir-type-link), `irTypeLinkPointerDown`(링크 경로), `irGoToType`→pendingPreviewHover→page-transition→$provideHover→native re-hover.
- **wheel guard**(`irHoverInternalWheelGuard`/`irPreviewTransitionWheelGuard`): hover 콘텐츠 스크롤 + 경계에서 preventDefault(over-scroll이 에디터로 전파→dismiss되는 것 방지). **관리 아님 — 게이트 금지(L97 교훈).**
- **size cap CSS**(.monaco-resizable-hover max-height:48vh + scroller overflow:auto): balloon 방지 — 유지 필요.
- **force-preview**(`irForcePreviewHoverVisible`): 드릴 가시성. flicker 의심 후보(아래 미해결 2).

## ★ 핵심 통찰 / 함정 (시간 많이 쓴 것)
1. **VS Code는 우리가 주입한 거대 콘텐츠를 네이티브로 캡하지 않음**(v255 balloon 입증). → size cap을 우리가 **반드시** 유지 → 고정 캡이 VS Code 네이티브 배치와 충돌 → **#1(스크롤 끝 스크롤바 화면밖/하단 짤림)은 구조적**. "100% native size" 불가. 유일 해법 = **뷰포트 클램프**(현재 no-op인 `irKeepHoverInViewport` ~L7976 최소 재활성: hover 하단이 뷰포트 밖이면 위로 nudge). 이게 불가피한 단 하나의 size 관리.
2. **`!important` 스타일시트는 인라인을 이김** → native resize 살리려면 override 말고 **제거**해야(L92).
3. **flag hoisting**: IR_HOVER_NATIVE_ONLY는 CSS 배열보다 위에서 할당(동기 실행).
4. **renderer-patch는 통째 template literal**: backtick·dollar-brace 보간·단일 backslash 이스케이프(개행/탭 등은 이중으로) 금지. tsc는 통과해도 주입이 깨짐. **수정 후 필수 검증**: 주입 — `node -e "new Function(require('./out/renderer-patch.js').getHoverPatchScript())"`; + 단일-backslash 이스케이프 재스캔(이전 세션 노드 스크립트 재사용, [[feedback_no_backticks_in_renderer_patch]]). (세션 시작 때 HEAD에 깨진 개행 이스케이프 3곳이 있어 overlay조차 주입 실패하던 것 발견·수정.)
5. **head/tail split = perf 레버**(full-highlight는 1657줄 동기 토크나이즈 = 1.5초 블록 + 드릴 page-transition 만료 유발).
6. **wheel guard는 scroll 지원이지 관리 아님** — 게이트하면 over-scroll이 에디터로 전파→dismiss(#4 회귀, v261→v262).
7. **로그는 창 혼재**: w=6=현재 테스트 창(v262), w=3/w=4=다른 옛 창. 분석은 `grep "w=6 v=NNN"` + 시간 슬라이스 필수([[feedback_log_mixes_windows]]).
8. **flicker** = release(`irReleaseNativeHoverManagement`, "outside-editor-new-token" 등)↔revive(`irTouchHoverRootContent`)↔force-preview keepalive churn. v262에서 release 게이트로 차단 시도(미검증).

## 미해결 (다음 세션 우선순위)
1. **v265 라이브 검증 (storm fix 수정 + L100 관리 게이트)** — 재시작 후: (a) 큰 호버 `viewport-wrap text=5XXXX` 횟수 ~95→**한자릿수**(storm 죽음?), (b) 스크롤 smooth·안 멈춤, (c) **드릴 여전히 작동?** — revive/visibility-keepalive 게이트라 drill이 native re-hover만으로 살아있어야 함. **드릴이 깨지면**(클릭 후 호버 사라짐/안 뜸) visibility-keepalive가 drill에 load-bearing이었던 것 → 게이트를 drill-only 예외로 좁히거나 native re-hover 보강.
2. **긴 호버 스크롤이 여전히 안 되면**(휠 `max=0`) 별건 = scroller 캡 미적용. 큰 호버 `.monaco-scrollable-element`가 `max-height:48vh`+`overflow:auto` 실제로 먹는지 직접 확인(native에서 `irMakeHoverScrollable` 게이트 OFF→CSS-only 의존). 필요시 native scroll-only 최소 헬퍼.
3. **#1 클램프(L98/v263) 검증** — 구현·배포됨, 발동 case 미발생(0회=정상). hover 하단이 실제 화면 밖인 case(뷰포트 하단 근처 큰 심볼)에서 `hover-viewport-clamp` 발동+하단 보이는지.
4. **남은 관리 churn 후속**(필요시): force-preview-zero-rect-transient(L78 keepalive)·force preview hover(drill-apply)가 아직 native에서 발동. drill 인프라라 보존했으나, 사용자가 여전히 "overlay 느낌"이면 force-preview도 게이트 검토(drill은 native re-hover). 9391↔6657 released-revive는 wrapper 재사용 보호라 마지막에.

## 빌드/검증/배포/측정
```
npm run compile && node -e "var m=require('./out/renderer-patch.js');new Function(m.getHoverPatchScript());console.log('INJECT OK v='+m.RENDERER_PATCH_VERSION)" && npm run bundle
npm run deploy:local     # 패키징+설치 → VS Code 재시작
# 로그 분석(단일 창, 시간 슬라이스):
awk 'substr($0,12,8)>="HH:MM:00"' log.txt | grep "w=6 v=262" > /tmp/s.txt
```

## 관련 메모리
[[project_native_hover_only_switch]] (이번 세션 전체 — 가장 상세, L89~L97), [[project_native_drill_eager_wrap]] (viewport-wrap/balloon), [[project_hover_jank_is_content_tokenization]] (head/tail), [[feedback_no_backticks_in_renderer_patch]] (주입 검증), [[feedback_log_mixes_windows]] (창 혼재).

---

# Handover: hover stability (pillar/position/collapse/staging) — L48~L81 + 모듈 refactor (Phase 2~16)

작성 시점: 2026-05-28 KST (저녁)
갱신:
- 2026-05-28 KST (밤) — Phase 15a/15b/16 추가
- 2026-05-29 KST — L62~L64 (initial-hover symbol-anchored reposition) 추가, v=212→217
- 2026-05-29 KST (낮) — L65 (DOM fallback elementsFromPoint + pre-cache helper) 추가, v=218. **hover-on-hover 회귀 발견 — L66 작업 필요**
- 2026-05-29 KST (오후) — **L66 (hover-on-hover detection) 구현, v=218→219**. `irPointerOverForeignHoverOverlay` reposition-time 검사 추가. tsc+bundle 통과, pillar/bar E2E gate 통과.
- 2026-05-29 KST (저녁) — **v=219 live 측정 → L66 0회 발동(전제 오류)**. VS Code 단일 hover wrapper 재사용이라 def-lookup hover-on-hover엔 foreign overlay가 없음. **방향 전환(사용자 선택): L67 (정지 첫 hover anchor 보강) 구현, v=219→220**. `irRepositionInitialHover`가 pos null일 때 singleton `__irCapturedHoverWidget.getPosition()`을 직접 호출해 capture 타이밍과 무관하게 anchor 복구. L66은 진짜 분리 overlay(peek/tooltip) 가드로 유지(주석 정정).
- 2026-05-29 KST (밤) — **v=220 측정 + 사용자 새 버그 보고**: "호버 떴을 때 다른 심볼로 빨리 이동하면 content는 바뀌는데 위치는 옛 심볼에 고정". 원인: 단일 wrapper content swap 시 우리 one-shot(`__irInitialPositioned`)이 재배치를 막고 **style observer가 옛 `__irDesired`를 4초간 재적용해 VS Code의 새 위치 이동을 되돌림**. **L68 (anchor-change reposition) 구현, v=220→221**: `irHoverAnchorMoved()`로 live widget anchor가 바뀐 걸 감지 → style observer가 pin 대신 새 심볼로 reposition, one-shot도 해제. tsc+bundle+E2E 통과. **commit 미실행 (사용자 요청 대기)**
- 2026-05-29 KST (밤늦게) — **v=221 log.txt 분석 → column-collapse(width 좁아짐) 회귀 발견 + L69 fix, v=221→222**. log.txt를 버전별로 정규화하니 `column-wrapper-detected shape=column`(16px 폭 붕괴)이 **v=221에서 4~5배 급증**(754줄당 40건, baseline ~10), 붕괴 wrapper의 **62%가 우리 `__irDesired` 부착**(baseline 17%). 원인: **L62가 initial hover를 `irRepositionInitialHover`로 라우팅**(committed v212는 non-drill early-return)하면서 모든 초기 wrapper에 `__irDesired`+style observer가 붙고, content swap 시 VS Code가 wrapper를 16px로 transient 붕괴시킬 때 **L68 style observer가 anchor-moved→reposition을 매 프레임 재호출(transient-skip 루프) + keepalive로 잔존** → 수 초간 고정 기둥. **L69**: collapse 가드 2개(style observer + reposition 진입)로 `width<60`/`height<20`이면 early-return(hands-off). tsc+bundle+E2E(col/bar clean, trans preserved) 통과. 별개로 **zero-rect(크기 0)은 전 버전 ~1%로 일정 → 회귀 아님, 기존 race로 분리 추적**.
- 2026-05-29 KST (다음날 오전) — **v=222 live 측정(log.txt 2279~) → L69 column fix 성공 확인 + 새 회귀 L70 fix, v=222→223**. column collapse는 ageMs 278~598ms로 정리(v=221 8초 고정 해소). 단 transient 가드 4곳의 `height<60`이 style observer 가드(`height<20`)와 불일치 → 정상 1줄 호버(`670×32` 32건)를 collapse로 오판해 reposition 거부 + churn loop(한 frame 23개 폭발). **L70**: 4곳 height 임계값 `60→20`으로 정렬. tsc+bundle+E2E 통과.
- 2026-05-29 KST (다음날 낮) — **v=223 live 측정(log.txt 5105~) → L70 검증 OK + 사용자 새 증상 보고**: "같은 심볼에서 char단위로 이동하면 호버가 char마다 따라오며 width collapse". 원인: `irHoverAnchorMoved`가 `position.column`만 비교 → 같은 단어 내 cursor 이동(column 변화)을 심볼 swap으로 오판해 char마다 reposition. **L71**: `__irPositionedForPos`에 word range 저장 + anchor-moved를 **range 비교**로 변경(같은 단어=range 동일→follow 안 함). v=223→224. tsc+bundle+E2E 통과.
- 2026-05-29 KST (다음날 저녁) — **v=224 live 측정(log.txt 7812~) → L71 작동 확인(anchor-moved 0건, char-follow 중단) BUT width=16px collapse 잔존**. 사용자 "아직 안 됐다". 증상: `point-wrap`(def-lookup 재발화) 직후 + 우리 `wrap`(navigable name 187개) 중 collapse. 기존 로깅은 collapse를 sweep으로 사후 발견만 함 → **L72: 진단 계측 추가**(동작 변경 없음). 새 he-event `width-collapse-transition`(collapse 시작·종료·inline width·content·point-wrap/wrap 상관) + stamp 2개. v=224→225. tsc+bundle+E2E 통과.
- 2026-05-29 KST (다음날 밤) — **v=225 측정(log.txt 8798~) → collapse 근본원인 규명 + L73 fix, v=225→226**. `width-collapse-transition` 8건 분석: 16px=VS Code가 wrapper width clamp(내용 멀쩡), 0×0=content swap 순간. 근본원인 = **같은 심볼 micro-move 시 hoverguard `outside-editor-token-relocation` 재발화(26건)** → VS Code 새 .monaco-hover 재렌더 → 우리 재size(reflow) → collapse. **L73**: `irPointerWithinActiveHoverAnchor` (포인터가 호버 anchor word range 안이면 release+refire 대신 호버 유지). tsc+bundle+E2E 통과.
- 2026-05-29 KST (다음날 밤2) — **v=226 측정(log.txt 9945~) → L73 미발동(0건) + 실제 dominant 원인 발견 + L74 fix, v=226→227**. 사용자 "간헐 width 줄어듦 + 내용 안보임 여전". L73는 `editorTarget` 블록 안이라 클릭/hover-위 세션에선 미발동. dominant = **`0×0` collapse(content 있음, textLen 1.7k~57k, transient)** — VS Code content swap 중 일시 0×0인데 **우리 `irDisposeHiddenActiveHover`가 dismiss로 오판해 release→revive churn**(flicker 증폭). **L74**: zero-rect+content-present면 release 안 하고 bounded skip(VS Code 회복 대기). tsc+bundle+E2E 통과.
- 2026-05-29 KST (다음날 밤3) — **사용자 가설: "dedupe가 만악의 근원"(사이즈 결정 중 프리징→복구 끊김/내용 잘림). → L75: DOM dedupe 임시 OFF(`IR_HOVER_DOM_DEDUPE_ENABLED=false`), v=227→228**. `irDedupeHoverContent`가 매 scan마다 57k자 정규식 + 블록 제거 + wrapper shrink/`__irDesired` 재작성 → 사이즈 충돌. tsc+bundle+E2E 통과.
- 2026-05-29 KST (다음날 밤4) — **v=228 측정: dedupe off로 가벼워졌으나 collapse/내용없음/위치 여전 + L74도 0건 발동**. 사용자 방향 전환: **"500ms 예산으로 위치+렌더 끝낸 뒤 보여주자"**. → **L76: reveal-when-settled staging**, v=228→229. 형성 과정을 `visibility:hidden`(ir-hover-staging)로 숨기고, `width≥60&&height≥20&&content&&dims안정`이면 reveal(상한 500ms). 단일 choke point(`irHoverRootVisibility`가 staged=visible 보고)로 기존 sweep 충돌 방지. hard-cap/error/dismiss fail-safe로 "호버 안 뜸" 방지. dedupe off 유지. tsc+bundle+E2E 통과.
- 2026-05-30 KST — **v=229 측정: staging 발동(43건) 확인되나 81% budget(500ms 대기), reveal 후에도 대형 호버 collapse/release**. 원인: 형성 중 navigable-name wrap(553 span)이 reflow 폭탄→settle 방해. → **L77(사용자 선택 A): staging 중 wrap defer, reveal 후 wrap**, v=229→230. staging 중엔 span 삽입 skip(sig 불변→피드백 루프 차단→빠른 settle), reveal 후 idle에 wrap 1회. tsc+bundle+E2E 통과. **commit 미실행 (사용자 요청 대기)**.
- 2026-05-30 KST (오후) — **log.txt 분석 → 드릴 프리뷰 zero-rect 전멸 발견 + L78 fix, v=230→231**. `force preview hover visible failed reason=zero-rect` **28건 전부 실패(회복 0)**: 드릴 link re-wrap 중 wrapper가 transient 0×0 붕괴 → `irForcePreviewHoverVisible`이 hard-fail 반환 → revive→`irReleaseNativeHiddenHover` release(=내용 사라짐). L74 zero-rect skip은 진입 visibility가 `hidden-class`라 **0건** 발동(빗나감). **L78**: force-preview가 zero-rect+content면 bounded(≤10) keepalive + `__irZeroRectTransientUntil`(250ms grace)로 dispose가 release **보류** + rAF 재확인. **v=231 측정: `hidden-active-hoverguard` release 0건**(dispose-hold 17·keepalive 20) → **성공**. tsc+bundle+E2E 통과.
- 2026-05-30 KST (저녁) — **v=231 측정 → 16px 필러 wrapper-collapse 추적 + L79 fix, v=231→232**. 신규 진단(`inlineDisplay`)으로 두 종류 분리: `rect 0×0`+`inlineDisplay:none` = **정당한 dismiss(버그 아님)**, `inlineW:16px`+`inlineDisplay:block` = **진짜 필러 버그**(content 있는데 inline width:16px가 스타일시트 `min(max-content,680px)` 덮어써 최대 **16.7초** 세로 슬리버로 stuck). 기존 `irScanNarrowHoverWrappers`는 감지만 하고 클래스만 떼 **width 복원 안 함**. **L79**: 콘텐츠 있는 column 필러는 stuck inline `width`/`min-width`를 episode당 1회 제거 → 스타일시트 재확장. **v=232 측정: `column-wrapper-width-restored` 14건, 16px→600/680 회복 확인**. 단 **진동 회귀** — `handle=79` 재-preview 21회·content mutation 53회로 ~2초마다 재붕괴→재복원(flicker). 근본원인은 상위 **re-preview churn(#3)**. tsc+bundle+E2E 통과. **commit 미실행**.
- 2026-05-30 KST (밤) — **#3 근본원인 규명 + L80 (proactive width-freeze) fix, v=232→233**. v=232 log 정밀 추적으로 **handover #3 가설이 틀렸음을 발견**: `handle=79` 재발화 5연속(15:55:50~58) 구간에 **`native show hover requested`/`irRequestNativeShowHover` 0건** → **우리 renderer refire가 아님**. 재발화 직전 1.4초 완전 침묵 + `width-collapse-transition`의 `ptr ageMs=445` → **마우스가 같은 단어 안에서 천천히 드리프트 → VS Code의 ~300ms hover delay가 `$provideHover`를 재호출**. 즉 gate할 우리 refire가 없고, VS Code 내부 재호출이라 직접 못 막음(null 반환은 dismiss 위험). flicker 메커니즘: VS Code가 같은 anchor에서 hover DOM rebuild → 우리 link span 42개 wipe(`1225 links=42`→`1254 links=0`) → rebuild 중 inner 일시 narrow → 우리 `width:min(max-content,680px)`가 16px collapse → 우리 re-wrap + L79 복원 = ~2초 주기 flicker. **사용자 선택: L80 렌더러 width-freeze**. content-present collapse(width<60, display≠none) 감지 시 직전 good 폭으로 **`min-width` floor**(min-width가 width를 이김 → VS Code 16px와 안 싸움)를 걸어 sliver가 안 보이게 holding, inner 콘텐츠가 재빌드되면(inner width≥60) 해제. style observer가 last-good width 연속 추적. **L80은 width collapse뿐 아니라 staging budget(re-stage 시 settle의 notCollapsed가 즉시 통과 → settled로 빠르게 reveal)도 동반 해소 예상**. 신규 he-event `width-freeze`(phase hold/release). tsc+bundle 통과. **별건 발견: L79가 이 E2E(`pillar/bar gate`)를 이미 깨뜨려 있었음**(working tree, handover의 "L79 E2E 통과"는 stale `out/`로 측정한 듯 부정확) — L79가 content-bearing column을 class-strip→width-restore로 바꿨는데 테스트는 옛 class-strip(keepalive 제거)을 기대. **시나리오1을 width-restore 기대로 갱신**(snapWrap에 `widthRestored`/`inlineWidth` 추가) → **E2E 1 passing 복구**. **commit 미실행**.
- 2026-05-30 KST (밤2) — **v=233 측정 → L80 0건 발동(또 wrong hook) + L81 re-hook, v=233→234**. v=233 live(17:35 세션, 973줄): **`width-freeze` 0건**(L73/L74처럼 미발동). 원인: L80 freeze 트리거가 **style observer**(wrapper style-attr mutation에만 발화)에 있는데, v=233의 실제 16px collapse는 **computed**(`width:min(max-content,680px)`가 inner 콘텐츠 일시 narrow 시 재계산)이라 style observer가 못 봄. style observer가 본 collapse 9건은 전부 `0×0 + display:none` 정당 dismiss(내 `display≠none` 가드가 올바르게 제외). 진짜 16px 기둥은 **sweep이 15건**(`column-wrapper-detected w:16`, content 184~59293자, 313~540ms 지속, ~2초 주기 재발) + **reposition 가드가 6건**(`initial-reposition-skip-transient rawW:16`) 감지 — 둘 다 RO/MO/sweep 경로. → **L81: freeze 결정을 `irMaybeFreezeCollapsedWidth` 헬퍼로 중앙화하고 검증된 3경로(reposition entry/post 가드 + sweep + style observer)에서 호출**. lastGoodWidth는 style observer + reposition 둘 다 캡처. **engagement 검증 E2E 추가**(harness freeze 시나리오: lastGoodWidth=600 set한 content column이 sweep으로 frozen+min-width:600 되는지 — L80류 미발동을 live 없이 잡음). **작업 중 함정**: sweep 편집 시 `var cwInnerHasOurClasses=...` 선언을 실수로 삭제(template literal이라 tsc 못 잡음 → 런타임 ReferenceError가 try/catch에 삼켜져 seenAt 미설정) → 복원. tsc+bundle+E2E(`freeze[frozen=true,minW=600px]` 포함) 통과. **commit 미실행**.

## 목표

VS Code editor native hover의 잔존/위치/시각 회귀를 진단하고 안전한 fix를 적용한다.

- **세로 기둥(width 16px) 또는 가로 줄(height 2px) 모양 wrapper**가 dismiss 후 visible로 남으면 안 된다.
- 정상 hover의 transient initial paint(VS Code가 이전 활성화 dimension으로 한 frame 그리는 단계)는 죽이면 안 된다.
- 몇 번 hover 후 hover 자체가 안 뜨는 회귀가 재발하면 안 된다.
- hover 창이 **커서가 보고 있는 심볼을 덮거나 처음 떴을 때 심볼에서 멀리** 뜨는 회귀를 **symbol-anchored reposition으로 직접 해결한다** (L62~L64). L57의 mouse-anchored fix가 부작용 일으켜 retire됐으나, L62의 symbol-anchored 접근으로 안전하게 override. 드릴 hover는 여전히 mouse-anchor.
- 호버 창이 viewport를 넘어가서 가려지지 않게 left/right/top/bottom clamp 한다 (L62).
- Editor column 전환 후에도 호버 위치가 깨지지 않게 widget capture에 의존하지 않는 DOM-based fallback path 사용 (L64).
- hover 배경이 editor 배경과 시각적으로 구분되도록 border가 있어야 한다 (light/dark theme 둘 다).
- production log에는 fix 발동 audit trail만 남기고, 진단용 30-필드 dump는 default로 끈다.
- E2E golden pass가 pillar/bar 시나리오(stuck cleanup + transient 보존)를 회귀 보호한다.

## 현재 상태

> **TL;DR (현재 build v=234, L48~L81)** — 호버 안정화는 "형성 과정을 숨겼다가 안정되면 1회 표시(staging)" + "재렌더 중 폭 붕괴를 proactive freeze로 안 보이게"로 수렴. 현재 활성 스택:
> - **위치 보정 (L62~L71)**: initial hover를 symbol-anchored 재배치(`irRepositionInitialHover`) + DOM/widget anchor fallback. content swap은 word **range** 비교로 새 심볼만 따라감(L71), 같은 심볼 내 char-follow는 안 함.
> - **collapse 가드 (L69/L70)**: width<60(column)·height<20(bar) 붕괴 중엔 hands-off → VS Code가 폭 회복하게 둠.
> - **dedupe OFF (L75)**: `irDedupeHoverContent`(매 scan 정규식+블록제거+shrink)가 사이즈와 충돌 → 비활성(`IR_HOVER_DOM_DEDUPE_ENABLED=false`).
> - **staging (L76) + wrap-defer (L77, 핵심)**: 형성 중(content 렌더+사이징+reposition)을 `visibility:hidden`(`ir-hover-staging`)로 숨기고 `width≥60&&height≥20&&content&&dims안정`이면(또는 500ms budget) reveal. 형성 중 navigable-name wrap(수백 span=reflow 폭탄)은 defer하고 reveal 후 idle에 wrap → 빠른 settle. 단일 choke point `irHoverRootVisibility`(staged=visible 보고)로 기존 sweep 충돌 차단. hard-cap/error/dismiss fail-safe로 "호버 안 뜸" 방지.
> - **드릴 zero-rect keepalive (L78)**: `irForcePreviewHoverVisible`(모든 revive/preview의 단일 choke point)가 transient 0×0(content 있음)을 hard-fail 하지 않고 bounded(≤10) keepalive + `__irZeroRectTransientUntil`(250ms grace)로 dispose의 release를 보류 + rAF 재확인. 드릴 프리뷰 "내용 사라짐" 해소(**v=231 release 0건 확인**).
> - **16px 필러 width-restore (L79)**: `irScanNarrowHoverWrappers`가 콘텐츠 있는 column 필러의 stuck inline `width`/`min-width`를 episode당 1회 제거 → 스타일시트가 재확장(**v=232 14건 회복**). 단 상위 re-preview churn(`handle` 재발화)으로 ~2초 주기 진동(flicker) 잔존 — 근본 해결은 churn 억제(#3) → **L80**.
> - **proactive width-freeze (L80→L81, #3 타겟)**: #3 churn의 재발화는 **VS Code 내부**(마우스 드리프트+~300ms hover delay, 우리 refire 아님 — v=232 측정 확정)라 진입 단계에서 못 막음. 대신 재렌더 중 폭 붕괴를 **안 보이게**: content-present collapse(width<60) 감지 시 직전 good 폭으로 `min-width` floor를 걸어(min-width가 VS Code의 width:16px를 이김) sliver를 holding, inner 콘텐츠 재빌드 시(inner width≥60) 해제. **L80은 style observer에만 hook해 v=233에서 0건 발동**(computed collapse는 style mutation 아님). **L81: `irMaybeFreezeCollapsedWidth` 헬퍼로 중앙화 + 검증된 3경로(reposition 가드 + sweep + style observer)에서 호출** → E2E engagement 테스트로 발동 확인(`freeze frozen=true`). **width collapse + staging budget 동반 해소 기대**. he-event `width-freeze`(hold/release). **live 측정 미완**(v=234 다음 세션).

**현황/측정 흐름** (각 fix는 live log로 검증):

- L69~L71 **verified**(column 8초고정 해소, 짧은호버 오거부 0, char-follow 0). L72 진단 계측 추가.
- L73(0건)·L74(0건) **미발동** → 개별 transient 가드는 코드 경로가 예상과 달라 계속 빗나감 → **L76 staging으로 방향 전환**(발동 확인 43건).
- L76 단독은 v=229에서 **81% budget(500ms 대기) + reveal 후에도 대형 호버 collapse** → 원인=형성 중 wrap(553 span) reflow → **L77 wrap-defer로 churn 제거**.
- L77(v=230) 후 분석에서 **드릴 zero-rect 전멸**(force-preview 28건 실패, 회복 0) 발견 → **L78(v=231)**: force-preview transient keepalive + dispose release 보류. **v=231 verified**(`hidden-active-hoverguard` release 0건).
- v=231 분석에서 wrapper collapse를 두 종류로 분리(신규 진단 `inlineDisplay`): 0×0=정당 dismiss / 16px=진짜 필러 버그(최대 16.7초 stuck) → **L79(v=232)**: 콘텐츠 있는 필러의 stuck inline width 제거. **v=232 부분 verified**(width-restored 14, 16px→600/680 회복) — **단 진동 회귀**(상위 re-preview churn).

**미해결/관찰 (v=234 기준)**:
- **#3 re-preview churn — L81로 타겟(live 측정 미완)**: 근본원인 확정 = **VS Code 내부 재호출**(마우스 드리프트+~300ms hover delay, 우리 refire 0건). 직접 못 막음 → **재렌더 중 폭 붕괴를 width-freeze(min-width floor)로 안 보이게**. **L80(v=233)은 style observer에만 hook해 0건 발동**(computed collapse는 style mutation 아님) → **L81(v=234): `irMaybeFreezeCollapsedWidth` 중앙화 + 검증된 경로(reposition 가드 6건 목격·sweep 15건 목격)에서 호출 + engagement E2E**. **v=234 live 측정 필수**: `width-freeze` 발동(0이면 또 미스), 16px 진동 소멸, settled↑.
- staging budget: v=233 settled 26/budget 15(63%, v=232 57%보다 개선이나 L80 미발동이라 변동일 수 있음). budget reveal 최대 1601ms 잔존(큰 호버). L81 freeze로 동반 개선 기대.
- **L79 E2E 회귀(수정됨)**: L79가 content-bearing column을 width-restore로 바꿨는데 E2E는 옛 class-strip 기대 → 시나리오1을 width-restore 기대로 갱신 → 통과 복구. + L81 freeze engagement 시나리오 추가.
- 상세는 아래 L-섹션 + "남은 회귀" 표.

**모듈 refactor**: Phase 2~14 baseline + 15a/15b/16 완료. extension.ts 21402 → 10620 lines (−50%). tsc+bundle+E2E(pillar/bar gate) 통과.

진행 추이 (v=213→230):

| 버전 | 주요 변경 | reposition 성공 / no-natural-pos skip | dominant 실패 |
|---|---|---|---|
| v=213 (L62) | irRepositionInitialHover 도입, body-MO 경로 wire-in | 0 / 12 | 함수 자체 미발동 (telemetry off + 캡처 미스) |
| v=214 (L62+) | irAttachWrapperResizeReposition을 hasBack 분기로 변경 (widget._editor 사용) | 30 / 146 | `editorDom.getBoundingClientRect is not a function` × 116 (mini-editor 캡처) |
| v=215 (L63a) | `typeof getBoundingClientRect==='function'` 가드 추가 | 1 / 29 | `no-editor-rect` × 28 (mini-editor 여전히 캡처) |
| v=216 (L63b) | `__irHoverNaturalEditor` (widget._editor)도 wrap 시점에 기억 → useEditor로 우선 | 15 / 48 | `no-natural-pos` × 48 (widget capture 자체 미스) |
| v=217 (L64) | DOM-based fallback (elementFromPoint → .monaco-editor → getTargetAtClientPoint) | 5 / 2 (적은 sample) | 거의 안정적 — 단 첫 hover에서 elementFromPoint가 hover wrapper 본인 반환 → fallback 실패 |
| v=218 (L65) | `elementsFromPoint` stack walk(hover overlay skip) + mouseover/pointerover에서 pre-cache | 11 / 131 | **hover-on-hover** (anchor가 hover overlay 안 element라 editor coord 추출 불가) |
| v=219 (L66) | `irPointerOverForeignHoverOverlay` — reposition 시점 hit-test stack에 wrapperEl 아닌 foreign hover overlay 있으면 skip(`overlay-anchor`) | **0 / 18** | **L66 0회 발동 — 전제 오류**(VS Code 단일 wrapper 재사용, foreign overlay 부재). 진짜 문제는 정지 첫 hover covers-cursor |
| v=220 (L67) | `__irCapturedHoverWidget.getPosition()` 직접 호출로 capture-timing-무관 anchor 복구(`posSrc=widget`) | **11 / 2** (posSrc=widget 0) | no-natural-pos 18→2(편차 가능). L67 미발동 — 효과 inconclusive. 그러나 사용자가 **새 버그(content swap 위치 고정)** 보고 |
| v=221 (L68) | `irHoverAnchorMoved` — content가 새 심볼로 swap되면 style observer가 옛 위치 pin 대신 새 심볼로 reposition(+ one-shot 해제). `__irPositionedForPos` 추적 | 측정 전 | A→B 빠른 이동 시 위치가 B로 따라옴 기대. `initial-reposition-anchor-moved` 발동 측정. **단 live 측정에서 column-collapse 회귀 유발(아래 L69)** |
| v=222 (L69) | collapse 가드 2개 — style observer + `irRepositionInitialHover` 진입에서 wrapper가 `width<60`(column) 또는 `height<20`(bar)이면 early-return(hands-off). 붕괴 중 re-pin/anchor-moved 루프 차단, VS Code가 `min(max-content,680px)`로 폭 회복하게 둠 | **column 성공**: ageMs 278~598ms(8초 고정 해소). 단 진입 가드 실제 코드는 `height<60`이라 짧은 호버 churn 잔존 | **height 임계값 불일치** — 진입/transient 가드는 `height<60`인데 style observer는 `height<20` → `670×32` 정상 호버 오거부 32건 + churn loop |
| v=223 (L70) | transient 가드 4곳(2170/2214/2454/2596) height 임계값 `<60`→`<20`로 style observer·column/bar 검출과 정렬. `width<60`(column)은 유지 | **검증 OK**: rawH=32 오거부 0, 짧은호버 reposition됨(hoverH=32 success), churn 폭발 0 | 같은 심볼 내 char-단위 호버 follow + collapse (사용자 보고) → L71 |
| v=224 (L71) | `irHoverAnchorMoved`를 column 비교 → **word range 비교**로 변경. `__irPositionedForPos`에 range 저장 | **검증 OK**: anchor-moved 0건(char-follow 중단). 단 width=16px collapse 잔존(point-wrap 재발화+wrap 직후) | char-follow는 멈췄으나 collapse 미해결 → L72 진단 계측 |
| v=225 (L72) | 진단 계측만(동작 변경 없음): `width-collapse-transition` he-event(collapse 시작·종료·inline width·content·상관) + point-wrap/wrap stamp + column-detected 보강 | **규명됨**: 16px=VS Code wrapper clamp / 0×0=content swap. 근본원인 = 같은심볼 재발화(`outside-editor-token-relocation` 26건) 재렌더 루프 | collapse 원인 확정 → L73 |
| v=226 (L73) | `irPointerWithinActiveHoverAnchor`: 포인터가 호버 anchor word range 안이면 hoverguard가 release+refire 안 하고 호버 유지 | **미발동(0건)** — `editorTarget` 블록 안이라 클릭/hover-위 세션엔 안 걸림(유효하나 dominant 경로 아님). dominant=transient 0×0 | L73는 유지(다른 케이스용). 0×0 원인 별도 → L74 |
| v=227 (L74) | `irDisposeHiddenActiveHover`: zero-rect인데 content 있는 transient 0×0이면 release/dispose 안 하고 bounded(10회) skip → VS Code 회복 대기 | 측정 전(L75와 함께 v=228에 포함) | "내용 안보임"/0×0 flicker 급감 + `hidden-active-zero-rect-skip` 발동 기대 |
| v=228 (L75) | **DOM dedupe 임시 OFF**(`IR_HOVER_DOM_DEDUPE_ENABLED=false`) — 사용자 가설 검증. `irDedupeHoverContent`(매 scan 57k자 정규식 + 블록제거 + wrapper shrink) 비활성 | **측정됨**: dedupe off(제거 0)로 가벼워졌으나 collapse 20/내용없음 12/position 5 여전, L74도 0건 발동 | 개별 transient 가드 한계 확인 → 방향 전환(L76 staging) |
| v=229 (L76) | **reveal-when-settled staging**: 형성 과정을 `visibility:hidden`로 숨기고 안정 또는 500ms budget에 reveal | **발동 확인(43건)** 이나 81% budget(500ms 대기), reveal 후에도 대형 호버 collapse. 원인=형성 중 wrap(553 span) reflow | staging 작동하나 churn이 budget 초과 → L77로 churn 제거 |
| v=230 (L77) | **navigable-name wrap을 reveal 후로 defer**: staging 중 wrap skip(span 삽입 안 함→reflow 폭탄·피드백 루프 제거→빠른 settle), reveal 후 idle에 wrap 1회 | 측정 중 **드릴 zero-rect 전멸 발견**(`force preview … failed reason=zero-rect` 28건, 회복 0). transient 0×0 붕괴→hard-fail→release | → **L78** (force-preview keepalive) |
| v=231 (L78) | **force-preview transient zero-rect keepalive**: zero-rect+content면 bounded(≤10) keepalive + `__irZeroRectTransientUntil`(250ms grace)로 dispose release 보류 + rAF 재확인 | **verified**: `hidden-active-hoverguard` release **0건** (dispose-hold 17 / keepalive 20). 정상 생명주기(active-switch/prune)로만 정리 | 16px 필러 wrapper-collapse 잔존(최대 16.7초 stuck) → L79 |
| v=232 (L79) | **16px 필러 width-restore**: 콘텐츠 있는 column 필러의 stuck inline `width`/`min-width`를 episode당 1회 제거 → 스타일시트 `min(max-content,680px)` 재확장 | **부분 verified**: `column-wrapper-width-restored` 14건, 16px→600/680 회복. 0×0=`inlineDisplay:none`(dismiss)·16px=`block`(필러) 진단 확정 | **진동 회귀**: 상위 re-preview churn(`handle=79` 21회·mutation 53회)으로 ~2초 주기 재붕괴→재복원 flicker → #3 |
| v=233 (L80) | **proactive width-freeze**: style observer가 content-present collapse(width<60) 감지 시 직전 good 폭으로 `min-width` floor를 걸어 sliver를 holding, inner 재빌드 시(width≥60) 해제. last-good width 연속 추적 | **측정됨: `width-freeze` 0건 발동** — style observer는 wrapper style-attr mutation에만 발화하나 실제 16px는 computed(`min(max-content)` 재계산)라 못 봄. sweep은 16px를 15건 봄 | **wrong hook**(L73/L74 재판) → L81 |
| v=234 (L81) | **freeze 결정 중앙화 + 검증된 경로로 re-hook**: `irMaybeFreezeCollapsedWidth` 헬퍼를 reposition 가드(RO/MO, 6건 목격)·sweep(15건 목격)·style observer 3곳에서 호출. lastGoodWidth는 style obs + reposition 캡처. E2E engagement 테스트 추가 | E2E `freeze[frozen=true,minW=600px]` 통과(발동 검증). 작업 중 `cwInnerHasOurClasses` 선언 실수 삭제→복원 | **live 측정 미완**(v=234): `width-freeze` 발동·16px 진동 소멸·settled↑ 확인 |

Phase 16 byte-equivalence 검증:

- (이전) `/tmp/getHoverPatchScript.txt` baseline MD5 = `71c3dd1c34fc8a4ae0729991b3d1247f` — **L62~L65 변경으로 무효화됨**
- 새 baseline은 L66 작업 시작 전에 다시 캡처할 것 (`tail -n +22 src/renderer-patch.ts | sed '1s/^export function /function /' > /tmp/new-baseline.txt && md5 /tmp/new-baseline.txt`)
- Phase 16 자체의 byte-exact 보존(L48~L61 hover 로직)은 깨졌지만, L62~L65는 모두 renderer-patch.ts 안 추가/변경이라 Phase 16의 추출/격리 원칙은 그대로 유효

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

### Initial hover symbol-anchored reposition (L62~L64) — 2026-05-29

L57의 mouse-anchored 실패에도 불구하고, 사용자 재요청으로 초기 호버 위치 직접 보정에 다시 도전. 이번엔 anchor를 **mouse가 아닌 symbol position**으로 잡아 L57 회귀 회피.

| Patch | v= | 내용 |
|---|---|---|
| **L62** | 213 | `irRepositionInitialHover(editor, wrapperEl)` 신규 함수. `__irHoverNaturalPosition` + `editor.getScrolledVisiblePosition` 으로 symbol 화면 좌표 계산 → above 우선 → below fallback → viewport clamp. `__irInitialPositioned` 별도 플래그 (drill의 `__irPositionedOnce`와 분리). style observer를 drill-only gate에서 desired-only로 확장. `irArmDrillSettleObserver`의 3개 사이트(immediate / resize callback / content-MO)에 wire-in |
| **L62-followup** | 214 | `irAttachWrapperResizeReposition`의 `if(!hasBack)return;` 게이트 제거 → `hasBack`로 분기: drill→drilled-reposition, !drill→initial-reposition. `widget._editor` 사용 — body-MO 경로의 `__irCapturedEditor`보다 안정적 |
| **L63a** | 215 | `typeof editorDom.getBoundingClientRect !== 'function'` 가드. v=214에서 mini-editor (hover 안 코드 블록의 read-only mini-editor)가 `__irCapturedEditor`에 잡혀 116× retry storm 발생 → 가드로 즉시 skip |
| **L63b** | 216 | `irWrapHoverWidgetGetPosition` 안에서 `window.__irHoverNaturalEditor = widget._editor` 같이 기억. 함수에서 `useEditor = __irHoverNaturalEditor \|\| editor`로 우선순위 부여. `no-editor-rect` 회수 |
| **L64** | 217 | **column-change fix.** Widget capture가 미스되면 `__irHoverNaturalPosition`/`Editor` 둘 다 null → `no-natural-pos` 다발(48/63). DOM-based fallback: `elementFromPoint(lastMouseX, lastMouseY)` → `.closest('.monaco-editor')` → `irListAllCodeEditors()` 매칭 → `editor.getTargetAtClientPoint(x, y)` 로 (line, column) 추출. 캡처 상태와 무관하게 작동. 성공 log에 `editorSrc` (`wrap` / `dom` / `arg`) + `posSrc` (`wrap` / `dom-target`) 필드 기록 |

#### 새 audit kinds (renderer-patch.ts top)

- `initial-reposition` — 발동 시점 + placement (`above` / `below` / `above-clamped` / `below-clamped`) + 소스 `editorSrc` (`wrap` / `dom` / `arg` / **`widget`**←L67) + `posSrc` (`wrap` / `dom-target` / **`widget`**←L67). **force-log + forwarded**
- `initial-reposition-skip` — 실패/skip reason (`no-wrapper` / `no-editor` / `no-natural-pos` / `no-visible` / `no-editor-dom` / `no-editor-rect` / **`overlay-anchor`** ← L66 hover-on-hover). **force-log** (L62 진단 단계, 안정화 후 forwarded-only로 demote 검토)
- `initial-reposition-skip-transient` — wrapper가 collapse 상태(width<60 column **또는** height<20 bar; L70 이전엔 height<60)일 때 retry 큐잉. `phase:'pre-oneshot'`(진입 가드, L69) / 없음(post-measurement). forwarded-only
- `initial-reposition-error` — try/catch fallback. forwarded-only
- `initial-reposition-anchor-moved` ← **L68**. content가 새 심볼로 swap되어 재배치 트리거됨. `via` (`style-obs` / `reposition`). **force-log + forwarded**

#### L62~L64 핵심 디자인 (memory rule 준수)

- **Mouse-anchor는 drill에만** (`[[feedback_mouse_anchored_drill]]`). 초기는 symbol anchor.
- **Drill의 `__irPositionedOnce`와 초기의 `__irInitialPositioned`는 서로 다른 플래그.** 한 wrapper가 초기→drill로 content swap 시 양쪽이 각자 1회만 reposition.
- Style observer는 둘 다 보호 (desired-only check) — VS Code의 `_resizableNode.layout()`이 top/left 덮어쓰면 재적용.
- `irResetWrapperPositionState`에 `__irInitialPositioned` / `__irInitReposRetries` 정리 추가.

### L65 (covers-cursor + widget-capture race) — 2026-05-29 낮 — v=218

L64는 단일 `elementFromPoint(mouseX, mouseY)`로 editor를 찾는데, **첫 hover가 mouse 위를 덮은 상태(covers-cursor)에선 그 좌표의 top element는 hover wrapper 자체** → `.closest('.monaco-editor')` null → `no-natural-pos`. 또 widget wrap path가 fire되기 전에 reposition 사이트가 fire되는 race window에선 `__irHoverNaturalEditor` / `Position` 둘 다 null.

| Patch | v= | 위치 | 내용 |
|---|---|---|---|
| **L65a** | 218 | renderer-patch.ts ~line 2355 | `irRepositionInitialHover`의 DOM fallback: `elementFromPoint` → `elementsFromPoint` (복수) stack walk. `.monaco-resizable-hover` / `.monaco-hover` / `.monaco-list` 안쪽 element는 skip하며 첫 진짜 `.monaco-editor` 찾기 |
| **L65b** | 218 | renderer-patch.ts ~line 4078 | `irPrecacheHoverNaturalContext(e)` 신규. `irRememberPointerEvent` 끝에서 호출. **mouseover/pointerover일 때만** (token-cross 시점). hover overlay 안 event는 skip (drift 방지). editor token이면 `ed.getTargetAtClientPoint(x,y)` → `__irHoverNaturalEditor` + `__irHoverNaturalPosition` 미리 cache. widget capture가 늦게 fire되어도 race window 메움 |

#### L65 검증 결과 — v=218 log 분석

| 지표 | v=216 (L63b) | v=218 (L65) | 평가 |
|---|---|---|---|
| reposition 성공 | 15 | 11 | 비슷 (사용량 차이 보정 필요) |
| no-natural-pos skip | 48 | 131 | **폭증** |
| anomaly | 12 | 20 | 증가 |
| editorSrc=dom 비율 | (L64 없음) | 0/11 | **L65a fallback 미작동** |

**원인 분석 (v=218 첫 hover 세션, log 2605~ 시작)**:

1. 08:59:02.093 lazy-hover content arrives (RsuTagCategoryManager) — mouseAgeMs=757ms (stationary)
2. 08:59:02.226 skip seq=1 no-natural-pos — widget capture 미스 + DOM fallback에서 editor 못 찾음 (이 시점엔 reposition이 wrapper appearance에 fire되는데 mouse는 token 위. 즉 elementsFromPoint stack의 첫 .monaco-editor가 잡혀야 하는데 잡히지 않음)
3. 08:59:02.710 anomaly far-from-cursor (mouseAgeMs=757 — stationary hover trigger)
4. **그 후 사용자가 hover wrapper 안에서 navigation:**
   - 08:59:03.143 pointerover target=hover-row "Symbol" link ← hover 안
   - 08:59:03.148 mouseover target=p "Symbol kind: class" ← hover 안
   - 08:59:03.654 mouseover target=hover-contents ← hover 안
   - 08:59:05.066 pointermove target=hover-contents ← hover 안
5. 08:59:06.337 새 hover trigger (Imported Symbol) — anchor가 **hover-row 안의 link**
6. 08:59:06.341 mouseover target=hover-row (705,356) — 우리 pre-cache가 hover overlay라서 skip ← reject
7. 08:59:06.350 skip seq=15 no-natural-pos
8. 08:59:06.360 anomaly covers-cursor

**근본 회귀 패턴: hover-on-hover**

- 사용자가 hover content 안의 link/token 위에 mouse 올려서 새 hover trigger (우리 extension의 def-lookup feature)
- 새 hover의 anchor token이 **editor가 아닌 hover overlay 안**의 element
- L65b의 pre-cache는 의도적으로 hover overlay 안 event를 skip (drift cache 방지)
- L65a의 elementsFromPoint stack walk는 editor를 찾을 수 있지만, mouse 좌표가 editor coord 변환에서 엉뚱한 token에 떨어짐
- 결과: `__irHoverNaturalPosition`이 유효한 editor position을 갖지 못함 → `no-natural-pos`

**[[feedback_mouse_anchored_drill]] memory rule에 따르면 이런 anchor 상황은 mouse-anchor가 올바른 동작**. drill hover (← Back 링크 + ir-drill-hover class)와 본질적으로 같은 anchor 상황인데, hover-on-hover는 marker가 없어서 우리 코드가 initial hover로 잘못 detect → symbol-anchor reposition 시도 → fail.

#### L65 결론

- L65a (elementsFromPoint)는 단독 첫 hover 케이스에서 fallback path가 작동할 가능성을 열어줌 — 단 v=218 세션에선 sample이 hover-on-hover로 편중되어 dom-source success가 0건. **유지**.
- L65b (pre-cache)는 진짜 첫 hover의 widget capture race window는 메우지만, hover-on-hover에선 의도적으로 skip. **유지**.
- 두 fix 모두 회귀를 일으키지 않음. v=217의 71% 성공률은 7건 sample에서 통계적 노이즈.

#### 남은 회귀: hover-on-hover (L66 대상) — v=218 시점 기록

| 회귀 | v=218 빈도 | 상태 |
|---|---|---|
| 첫 hover stationary 진입 시 covers-cursor anomaly | ~5건/세션 | L65b pre-cache가 mouseover 시점 잡았어야 하는데 wireup/타이밍 추가 진단 필요 (L66 범위 밖, 잔존) |
| **hover-on-hover의 새 hover가 cursor 덮음 / 멀리 뜸** | ~15건/세션 | **L66 (v=219)에서 detection 추가 — 아래 참조** |
| `initial-reposition-skip no-natural-pos` | 131건 | 거의 모두 hover-on-hover. L66이 `overlay-anchor`로 선분류 → no-natural-pos 자연 감소 예상 (v=219 측정 필요) |

#### L66 후보 안 (검토 기록) — 채택: 안 1 변형

1. **(채택)** wrap/reposition 진입에서 mouse가 hover overlay 안인지 검사 → hover overlay면 skip, VS Code 자체 positioning에 맡김.
2. widget._anchor / widget._range 검사 — anchor가 editor IRange인지 검사. (VS Code 내부 구조 의존, fragile하여 미채택)
3. drill의 mouse-anchored reposition 재사용 — `irRepositionDrilledHoverByElement` 적용. (동작 변경 폭 큼, 미채택)

안 1을 그대로 쓰면 **covers-cursor 정상 첫 hover에서 false-positive** 위험이 있음: 정상 첫 hover가 커서를 덮으면 `elementFromPoint(mouse)`가 새 wrapper 자신을 반환 → hover overlay로 판정 → 잘못 skip. 그래서 안 1을 **"foreign overlay" 검사로 변형**해서 채택 (아래).

### L66 (hover-on-hover detection) — 2026-05-29 오후 — v=219

`irPointerOverForeignHoverOverlay(wrapperEl)` 신규 helper (renderer-patch.ts, `irRepositionInitialHover` 직전 ~line 2330). `irRepositionInitialHover`의 one-shot 게이트(`__irInitialPositioned`) 직후에 호출(~line 2385). hover-on-hover면 `irHERecord('initial-reposition-skip',{reason:'overlay-anchor'})` 찍고 return.

**핵심 디자인 — "foreign overlay" 판정으로 covers-cursor false-positive 회피**:

- reposition 시점에 `document.elementsFromPoint(__irLastPointer.x/y)` hit-test stack을 walk.
- stack의 각 element가 `.monaco-resizable-hover` / `.monaco-hover` / `.monaco-list` 안인지 검사.
- 그 overlay가 **지금 repositioning 하려는 `wrapperEl` 자신(또는 contains 관계)이면 skip하고 계속** walk — 이게 covers-cursor(정상 첫 hover가 커서 덮음) 케이스이며, **이건 여전히 symbol-anchor reposition 해야 함**.
- `wrapperEl`이 아닌 **다른(foreign) hover/list overlay**를 발견하면 → hover-on-hover로 판정 → `true` 반환 → reposition skip.
- 즉 "커서 밑에 내가 옮기려는 hover 말고 *다른* hover가 깔려 있다 = 그 다른 hover 안 link에서 trigger된 nested hover다"라는 직접 신호.

**왜 stored flag가 아닌 live 검사인가**: Chromium은 stationary 커서 밑에 새 element가 paint되면 synthetic mouseover/mouseout(boundary event)을 dispatch한다. 이걸 pre-cache 시점 stored flag로 잡으면 정상 첫 hover에서도 "overlay에서 trigger됨"으로 오판될 수 있다. reposition 시점 live hit-test는 이 타이밍 레이스에 영향받지 않는다 (현재 DOM 상태만 본다).

**구현 노트**:

- `wrapperEl = widget._resizableNode.domNode` = `.monaco-resizable-hover` (renderer-patch.ts line 1264, 1453에서 확인).
- skip 시 `__irInitialPositioned`는 **설정하지 않음** — 기존 `no-natural-pos`/`no-editor` skip과 동일. wrapper가 VS Code에 의해 재사용되어 정상 hover로 바뀌면 `irResetWrapperPositionState` 없이도 다음 trigger에서 재평가됨. (재평가 시 elementsFromPoint 1회 비용은 허용.)
- 새 reason `overlay-anchor`는 별도 kind 등록 불필요 — `initial-reposition-skip` kind는 이미 `IR_HE_FORWARDED_KINDS`(line 496) + `IR_HE_FORCE_LOG_KINDS`(line 567) 둘 다 등록됨.
- drill check(`hasBackInit`)가 guard보다 먼저라, drill-on-hover는 drill 경로로 먼저 빠짐 (이미 mouse-anchor).

**L66 한계 (다음 세션 측정 대상)**:

- 검사는 reposition 시점 mouse가 **여전히 source overlay 위**에 있어야 동작. 사용자가 nested hover trigger 직후 mouse를 새 hover content 위로 빠르게 옮기면(reposition window ~1frame~300ms 안) `__irLastPointer`가 새 hover 위를 가리켜 foreign overlay 미검출 → false-negative 가능. drift 잦으면 v=219 telemetry 보고 안 1+pre-cache token-cross 신호 병합(synthetic event guard 포함) 재검토.
- L66은 hover-on-hover를 **reposition에서 손 떼게** 할 뿐, VS Code 자체 placement가 커서를 덮는 건 그대로. handover 결론대로 hover-on-hover의 mouse-anchored placement는 의도된 동작으로 간주. 만약 v=219에서도 사용자가 covers-cursor를 불편해하면 안 3(drill식 mouse-anchor reposition)으로 격상 검토.

#### L66 v=219 live 측정 결과 — 전제 오류 발견

log.txt v=219 구간(lines 4260~5028, 3 hover 세션):

| 지표 | v=218 | v=219 |
|---|---|---|
| `initial-reposition` 성공 | 36 | 10 (above 8 / below 2, 전부 `posSrc=wrap`) |
| `no-natural-pos` | 131 | 18 |
| **`overlay-anchor` (L66)** | — | **0** |
| `hover-position-anomaly` | 20 | 0 |
| `editorSrc=dom` (flinging 위험) | 0 | 0 |

**근본 원인 — VS Code 단일 wrapper 재사용**:

```
.monaco-resizable-hover   ← wrapperEl (reposition 대상, 재사용 singleton)
 └ .monaco-hover           ← 자식
    └ .hover-contents / .rendered-markdown / .hover-row
```

- 사용자가 hover 내용 위로 mouse를 올려도(`target=div class=hover-contents`, `class=monaco-hover ir-keepalive`, `class=hover-row` 로그로 확인) `elementsFromPoint`가 주는 overlay는 wrapperEl의 **자식** → `wrapperEl.contains(overlay)` 가드가 "같은 wrapper"로 정확히 판정 → skip → **foreign overlay 부재로 영원히 false**. L66의 "분리된 두 overlay" 전제가 def-lookup hover-on-hover와 불일치.
- 이 세션엔 실제 중첩 hover trigger도 없었음: 드릴 0 / `point-wrap accept` 0 / `← Back` 0.
- 18 no-natural-pos는 hover 3개에 몰린 **재시도 storm**(≈6회/hover). 예: seq 7~13은 mouse 고정(837,470)에 content streaming resize 반복. (no-natural-pos가 one-shot 플래그를 안 세움.)
- flinging 없음(`editorSrc=dom`=0). 즉 이 케이스들은 이미 VS Code placement를 그대로 둠.

**결론**: L66은 무해하나 def-lookup hover-on-hover엔 죽은 코드. 진짜 문제는 **정지 첫 hover covers-cursor**(widget capture race). → L67로 전환.

### L67 (정지 첫 hover anchor 복구) — 2026-05-29 저녁 — v=220

`irRepositionInitialHover` 안, `pos`/`useEditor`를 wrap+pre-cache에서 읽은 직후 + DOM fallback 직전에 삽입 (renderer-patch.ts ~line 2398).

```js
if(!pos||!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function'){
  var hw=window.__irCapturedHoverWidget;          // 재사용 singleton content-hover widget
  if(hw&&typeof hw.getPosition==='function'){
    try{var gp=hw.getPosition();                  // wrapped getter: live anchor 반환 + 캐시 back-fill
      if(!pos&&gp&&gp.position){pos={lineNumber:gp.position.lineNumber,column:gp.position.column};posSrc='widget';}
    }catch(_){}
    if((!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function')&&hw._editor&&typeof hw._editor.getScrolledVisiblePosition==='function'){
      useEditor=hw._editor;editorSrc='widget';
    }
  }
}
```

**왜 이게 정지 첫 hover를 고치나**: `irWrapHoverWidgetGetPosition`은 VS Code가 wrap **이후** getPosition()을 호출해야 `__irHoverNaturalPosition`을 채운다. 커서가 이미 멈춘 채 hover가 뜨면 VS Code가 sniffer 캡처 전에 widget을 배치해버려 wrap이 늦고 캐시가 빈다 → no-natural-pos. widget은 singleton(`__irCapturedHoverWidget`)이라 우리가 **직접 getPosition()을 호출**하면 capture 타이밍과 무관하게 anchor를 얻는다 (getPosition은 `{position, range, preference}` 반환 — line 2696). DOM fallback(커서 밑 픽셀)보다 authoritative라 우선.

**전제·한계**:

- `__irCapturedHoverWidget`이 set돼 있어야 함. 세션 첫 캡처 이후엔 singleton이라 계속 유효(이 세션 10건 success가 wrap 경로 = 캡처 됨). 세션 최초 hover가 정지 상태면 아직 미캡처라 못 고침(희귀).
- hover-on-hover(content swap)에서도 getPosition()이 호출되면 `posSrc='widget'`로 reposition될 수 있음. 그 anchor가 nested symbol을 가리키면 올바른 동작, 엉뚱하면 회귀 — v=220 telemetry에서 `posSrc=widget` 분포로 감시.

**L66 처리**: foreign-overlay 가드는 peek view / 별도 `.monaco-hover` tooltip 같은 **진짜 분리 overlay**엔 여전히 유효 → 유지. 단 주석을 실측(단일 wrapper)에 맞게 정정.

#### L67 검증 (v=220)

- `npx tsc -p ./ --noEmit` + `npm run bundle` 통과. 번들에 `posSrc='widget'` + version 220 반영 확인.
- `IR_E2E_GREP="pillar/bar wrapper" npm run test:python` → **1 passing**, `col[clean=true], bar[clean=true], trans[preserved=true]`. 회귀 없음. (`Method not found: getId/getDomNode`는 V8 inspector harness 기존 noise.)
- v=220 live 측정: `no-natural-pos` 18→2, 그러나 `posSrc=widget` **0건**(11 success 전부 wrap). L67 경로는 이 세션에서 미발동 — no-natural-pos 감소는 session 편차로 추정, L67 효과는 **inconclusive**. (정지 첫 hover repro가 적었던 듯.)

### L68 (anchor-change reposition — content swap) — 2026-05-29 밤 — v=221

**사용자 버그**: "호버가 떴을 때 다른 심볼로 빨리 이동하면 기존 호버의 content는 바뀌는데 위치는 안 바뀜."

**원인** (v=220 측정 + 코드 분석):

- VS Code는 hover wrapper를 하나만 재사용. A→B 이동 시 같은 wrapper에 B content를 swap하고 **VS Code 자체는 B 위치로 top/left를 재작성**한다.
- 그러나 우리 **style observer**(`irAttachStyleObserverToWrapper`)가 VS Code의 top/left 재작성을 감지하면 옛 심볼 A의 `__irDesired`를 **4초간 다시 덮어써서** 위치를 A로 되돌린다 → content=B, 위치=A.
- 추가로 one-shot `__irInitialPositioned`(dismiss 없으면 안 지워짐)가 우리 reposition도 막는다.

**L68 수정**:

- `irHoverAnchorMoved(wrapperEl)` 신규 helper (renderer-patch.ts, style observer 직전): `__irPositionedForPos`(우리가 positioning한 anchor)와 live `__irCapturedHoverWidget.getPosition().position`을 비교. 다르면 content가 새 심볼로 swap된 것.
- **reposition 끝에 `wrapperEl.__irPositionedForPos={lineNumber,column}` 저장** (anchor 비교 기준).
- **style observer**: VS Code가 top/left를 바꿨을 때(`curTop!==desired.top`) `irHoverAnchorMoved`면 → stale `__irDesired` 재적용하지 않고 삭제 + one-shot 해제 + `irRepositionInitialHover` 호출(새 심볼 B로 symbol-anchored 재배치). **이 경로는 `irAttachWrapperResizeReposition`의 300ms gate를 우회**하므로 빠른 이동도 즉시 처리.
- **one-shot 게이트**(`irRepositionInitialHover` 진입): `__irInitialPositioned`여도 `irHoverAnchorMoved`면 desired 삭제 + 플래그 해제 후 재배치 진행. (RO/MO 등 다른 trigger 경로도 커버.)
- `irResetWrapperPositionState`에 `__irPositionedForPos` 정리 추가.
- 새 kind `initial-reposition-anchor-moved` (`via:'style-obs'` / `'reposition'`) force-log + forwarded 등록.

**재진입/루프 안전성**: reposition이 style.top/left=B를 쓰면 style observer가 다시 fire되지만, 그땐 `__irPositionedForPos`=B=live → `irHoverAnchorMoved`=false, 그리고 `curTop(B)===desired(B).top` 조기 return → 루프 없음. 정상 단일 hover의 pin 동작(같은 심볼)은 anchor 불변이라 그대로 유지.

**한계**: live anchor를 못 읽으면(`__irCapturedHoverWidget` null 또는 getPosition position 없음) 감지 실패 → 옛 동작(pin) 유지. 흔치 않음.

#### L68 검증 (v=221)

- `npx tsc -p ./ --noEmit` + `npm run bundle` 통과. 번들에 `irHoverAnchorMoved` + `__irPositionedForPos` + `initial-reposition-anchor-moved` + version 221 반영 확인.
- `IR_E2E_GREP="pillar/bar wrapper" npm run test:python` → **1 passing**, col/bar clean, trans preserved.
- **runtime 측정 다음 세션 과제**: A→B 빠른 이동 시 위치가 B로 따라오는지 육안 확인 + `initial-reposition-anchor-moved` 발동 분포(`via` 별) 측정.

### L69 (column-collapse / width 좁아짐 회귀 fix) — 2026-05-29 밤늦게 — v=222

**증상 (사용자 보고)**: 호버의 width가 16px 세로 기둥으로 좁아지고, 가끔 크기가 0이 됨.

**진단 (log.txt v=212~221 버전별 정규화)**:

| 지표 | baseline(v=216~220, 754줄 환산) | v=221 |
|---|---|---|
| `column-wrapper-detected shape=column` (16px 붕괴) | ~10 | **40 (4~5배)** |
| 그중 `wrapHasDesired:true` (우리 `__irDesired` 부착) | 17% | **62%** |
| `initial-reposition-anchor-moved` (L68 신규) | — | 7 (style-obs 6 / reposition 1) |
| `initial-reposition-skip-transient rawW=16` | 적음 | 25 |
| `reason=zero-rect` (크기 0) | ~1% | ~1% (**일정 → 회귀 아님**) |

- v=221 타임라인 결정적 증거: `initial-reposition [W=670 H=648]`(우리가 full-size positioning) → 0.5초 후 `column w=16 h=648 desired=true`(같은 wrapper, height 유지·width만 붕괴, 우리 상태 부착) → seq 46~72는 **8초 넘게 `column w=16 desired=true` 고정**.

**근본 원인**:

1. `irRepositionInitialHover`는 **working tree 신규**(committed HEAD엔 0개). **L62가 resize observer의 non-drill early-return(`if(txt.indexOf('← Back')<0)return;`)을 제거**하고 모든 initial hover를 이 함수로 라우팅 → 초기 wrapper마다 `__irDesired` + style observer + `__irInitialPositioned` 부착.
2. 16px 붕괴 자체는 VS Code transient (content swap 시 inner width→0 → wrapper `width:min(max-content,680px)`가 border≈16px로 평가). baseline에도 `desired=false`로 존재하나 **짧고 무해**.
3. v=221에서 악화: **L68 style observer가 VS Code의 매 style mutation마다 발동** → 붕괴 중 `irHoverAnchorMoved`→`irRepositionInitialHover` 재호출. 기존 transient 가드는 one-shot/anchor-moved bookkeeping **이후**라, `__irDesired`를 지웠다 재시도 큐잉하는 churn 루프. `ir-keepalive`까지 붙어 sweep이 prune 못 함 → 짧은 transient가 수 초 고정 기둥으로 변질.

**L69 수정 (collapse 가드 2개, 둘 다 early-return = "덜 하기")**:

- **style observer** (`irAttachStyleObserverToWrapper`, `if(!desired)return` 직후): `wrapperEl.getBoundingClientRect()`가 `width<60` 또는 `height<20`이면 return. 붕괴 중 re-pin도 anchor-moved 루프도 안 함 → VS Code가 폭 회복하게 둠.
- **`irRepositionInitialHover` 진입** (`hasBackInit` 체크 직후, one-shot/anchor-moved **전**): `width<60||height<60`이면 `initial-reposition-skip-transient`(`phase:'pre-oneshot'`) 기록 + 200ms 재시도(최대 3) 후 return. 붕괴 중 우리 상태(`__irDesired`/`__irInitialPositioned`) 보존.

**왜 follow-to-B(L68 기능)가 보존되나**: 붕괴 중엔 손 떼지만, wrapper가 full-size로 회복되면 resize observer가 `irRepositionInitialHover`를 재호출 → 그때 `__irInitialPositioned`는 true·live anchor=B·`__irPositionedForPos`=A → anchor-moved 감지 → B로 재배치. 16px shell이 아니라 회복된 full-size에서만 reposition하므로 **strictly 개선**.

**다른 extension overlay 안전성 (사용자 제약 "다른 extension의 overlay는 망치지 마")**: 두 가드 모두 `__irDesired`를 가진 wrapper(=우리가 positioning한 VS Code content-hover)에만 도달. peek view / 별도 tooltip 등 `__irDesired`·style observer 없는 overlay는 경로에 안 들어옴. 새 selector·전역 observer 추가 없음. early-return은 동작을 **줄일 뿐**이라 새로 건드리는 대상이 생길 수 없음.

#### L69 검증 (v=222)

- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과. 번들(`out/renderer-patch.js`, `out/extension.js`)에 `RENDERER_PATCH_VERSION = 222` + `soRect` 가드 + `phase:'pre-oneshot'` 반영 확인.
- `IR_E2E_GREP="pillar/bar wrapper" npm run test:python` → **1 passing**, `col[clean=true], bar[clean=true], trans[preserved=true]`. 기존 2-pass cleanup 회귀 없음. (`Method not found: getId/getDomNode`는 V8 inspector harness 기존 noise.)
- **runtime 측정 다음 세션 과제 (최우선)**: v=222 live 세션에서 `column shape=column wrapHasDesired=true` 비율이 baseline(~17%)로 복귀하는지 + `initial-reposition-anchor-moved`가 붕괴 중 폭증 안 하는지 + 육안으로 width 좁아짐/크기 0 해소 확인.

### L70 (short-hover 과잉거부 / churn loop fix — height 임계값 정렬) — 2026-05-29 (v=222 측정 후) — v=223

**v=222 live 측정 결론**: L69의 column collapse(width 16px) fix는 **성공** — `column-wrapper-cleaned ageMs`가 278~598ms(sub-second transient)로, v=221의 8초 고정 기둥이 사라짐. (ageMs=84368 1건은 reactivation 경계를 넘은 이전 세션 잔존물, 별개.) 단 측정에서 **새 dominant 신호 발견**:

| 지표 (v=222, log line 2279~) | 값 |
|---|---|
| `initial-reposition` 성공 | 21 (최소 hoverH=94 — height≤60 호버 0건) |
| `initial-reposition-skip-transient phase=pre-oneshot` | **54** |
| 그 중 `rawW=670, rawH=32` (정상 1줄 호버) | **32** |
| `rawW=16, rawH=648/166/4` (column collapse) | 11 |
| `rawW=680, rawH=4` (bar collapse) | 11 |
| `initial-reposition-anchor-moved` | 6 (style-obs 3 / reposition 3) |

**근본 원인 — height 임계값 불일치** (L62부터 잠복, L68/L69로 표면화):

- `irRepositionInitialHover`의 transient 가드 4곳(진입 pre-oneshot / post-measurement / ResizeObserver pre-gate / content-MO pre-gate)은 `width<60 || height<60`을 썼다. 그러나 L69가 추가한 **style observer 가드(line 1205)는 `width<60 || height<20`**.
- 실제 collapse 모양은 **column = width 16**, **bar = height 2~4** 뿐. `height<60`은 **정상 짧은(1줄) 호버**(예: `670×32` — width 670은 full-laid-out = 완성된 호버)를 collapse로 오판한다.
- 결과 1: height≤60 호버는 **reposition을 영영 못 받음**(v=222 success 최소 height=94, 32px 호버 0건) → 짧은 호버가 커서를 덮어도 안 옮겨짐.
- 결과 2: **churn loop**. 짧은 호버 content swap 시 style observer(height 32 > 20 → 통과)가 `irHoverAnchorMoved`→`irRepositionInitialHover` 호출 → 진입 가드(height 32 < 60 → skip)에서 `__irDesired` 삭제된 채 skip+200ms retry. mutation마다 반복 → `14:44:27.070` 한 frame에 reposition 4 + skip-transient 15 (총 23) 폭발.

**L70 수정**: transient 가드 4곳의 height 임계값을 `<60` → `<20`으로 내려 style observer 가드 + column/bar 검출(`height<20`)과 **일관 정렬**.

- line 2170 (ResizeObserver pre-gate), 2214 (content-MO pre-gate), 2454 (진입 pre-oneshot), 2596 (post-measurement) — 모두 `width<60 || height<20`.
- `width<60`(column collapse + 0×0 unrendered)은 유지 → L69 column 보호 + zero-rect skip 그대로.
- `height<20`은 bar collapse(≤4px)와 0×0은 여전히 skip하되 정상 짧은 호버(≥~26px)는 통과.
- 효과: (1) churn loop 차단(style observer와 reposition이 같은 임계값 → 서로 재호출 안 함), (2) 짧은 호버도 symbol-anchored reposition 받음.

**drill 경로 미변경**: `irRepositionDrilledHover`(line 1539) + back-restore(line 1877)의 `height<60`은 그대로 — v=222에서 `drill-reposition-skip-transient` 0건(미발현) + drill은 mouse-anchored([[feedback_mouse_anchored_drill]]) 별도 경로라 scope 밖. (선택 follow-up: 일관성 위해 동일 정렬 가능.)

**한계 (streaming-grow edge)**: height<20로 내리면 streaming 중 짧게 측정된 호버(예: 30px→200px 성장)를 30px 시점에 positioning할 가능성이 height<60 때보다 늘어남. 단 (a) 이 risk는 60px 경계에도 이미 존재했고, (b) v=222 dominant(`670×32`)는 width 670=full-laid-out이라 사실상 final. one-shot이 grow 후 재배치를 막는 건 별개 follow-up(resize 기반 size-moved 감지).

#### L70 검증 (v=223)

- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과. 번들에 `RENDERER_PATCH_VERSION = 223` + 4곳 `height<20` 반영 확인.
- `IR_E2E_GREP="pillar/bar wrapper" npm run test:python` → **1 passing**, `col[clean=true], bar[clean=true], trans[preserved=true]`. pillar/bar sweep(별도 경로) 회귀 없음.
- **runtime 측정 다음 세션 과제**: v=223 live에서 `initial-reposition-skip-transient rawW=670 rawH=32`(짧은 호버 오거부)가 사라지고 `initial-reposition` 성공에 height<60 케이스가 포함되는지 + `14:44:27`식 동일-frame churn 폭발 부재 확인.

### L71 (char-단위 follow / micro-move collapse fix — anchor-moved를 range 기반으로) — 2026-05-29 (v=223 측정 후) — v=224

**사용자 증상**: "같은 심볼에서 조금씩 오른쪽으로 이동하면 호버 위치가 char단위로 갱신되는데, 이때 위치를 바꾸면서 width가 collapse됨."

**v=223 live 측정 (log.txt 5105~, 새 세션 15:59~16:00, `trial-ending-notification`)**:
- L70 재확인 OK (짧은호버 오거부 0, churn 폭발 0).
- 증상 구간(16:00:08~19): 토큰 rect `1720,504,101×14`(101px≈14자) 위에서 `hoverguard outside-same-token-pass`가 40ms마다 발동(keep-alive pass, reposition 아님). 그 사이 `initial-reposition-anchor-moved via=style-obs` + `initial-reposition`이 반복되며 `left`=1720/1756/1734 (**전부 그 토큰 폭 안**) → 같은 단어 내 sub-char 이동에 호버가 따라다님.
- column-detected(collapse)는 reposition보다 **선행**(11.766 collapse → 11.773 reposition) → collapse는 VS Code 재렌더, 우리 reposition은 회복 후 새 column으로 점프(=follow). `renderer-pointer-refire`(우리 refire)는 ~1-2초 간격이라 per-char 아님.

**근본 원인**: `irHoverAnchorMoved`가 live `getPosition().position.column`과 `__irPositionedForPos.column`을 비교. 같은 단어 안에서 cursor가 움직이면 column이 바뀌니 "심볼 swap"으로 오판 → L68 anchor-moved 경로가 char마다 재배치. 호버 anchor는 **단어 range**에 붙는데(getPosition은 `{position, range}` 반환, range=단어 경계) column만 봐서 생긴 문제.

**L71 수정**:
- `__irPositionedForPos`에 **word range 저장**(`irClonePositionForFreeze`가 이미 clone하는 `__irHoverNaturalPosition.range` 우선, 없으면 live widget `getPosition().range`).
- `irHoverAnchorMoved`(line 1169): live `gp.range`와 `prev.range`가 **둘 다 있으면 range 비교**(start/end line·column 4개) — 다를 때만 moved. 같은 단어 내 column 변화는 range 동일 → **moved=false → reposition 안 함**(호버 고정). range 없으면 기존 line/column 비교로 fallback(L68 swap 검출 보존).

**효과**: 같은 심볼 내 micro-move 시 호버가 **첫 위치(symbol-anchored, off-cursor)에 고정** — char follow 중단(style observer가 anchor-moved=false면 `__irDesired`로 re-pin). 밑의 VS Code 재렌더 collapse는 L69/L70 hands-off가 흡수 + 호버 점프 안 함 → 체감 격감. L68(A→B 다른 심볼 swap)은 range가 달라 그대로 reposition — 보존.

**한계**: collapse 자체(VS Code 재렌더 transient)는 별개. follow 중단으로 체감은 크게 개선되나, 잔존 collapse-flicker가 보이면 native-refire / VS Code hover position tracking 별도 조사.

#### L71 검증 (v=224)
- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과(v=224, range 비교/저장 반영). E2E pillar/bar gate **1 passing**(col/bar clean, trans preserved).
- **runtime 측정 다음 세션**: 같은 심볼 내 좌우 이동 시 `initial-reposition-anchor-moved`가 (거의) 안 뜨는지 + 호버가 고정되는지 육안 + 잔존 collapse 빈도.

### L72 (width-collapse 진단 계측 — L71 후 잔존 collapse 추적) — 2026-05-29 (v=224 측정 후) — v=225

**v=224 live 측정 (log.txt 7812~, 새 세션 19:17~19:18, `index.html`)**:
- **L71 작동 확인**: `initial-reposition-anchor-moved` **0건**(이전엔 char마다 발동) → range 비교로 같은 단어 내 char-follow 중단됨. ✅
- **그러나 width=16px collapse는 잔존**: 19:18:44~48에 `column-wrapper-detected wW=16px desired=true` 5건(innerTextLen 1362~4084). 사용자도 "아직 안 됐다" 보고.
- 증상 메커니즘(raw 추적): `point-wrap "SubscriptionPlan" event=pointerover`(def-lookup 재발화) **직후** collapse. 그 토큰(125px) 위에서 `near-link pre-range`/`outside-same-token`가 반복, content swap 중 `wrap text=4051 wrapped=187`(우리가 navigable name 187개 wrap) + `irMakeHoverScrollable`(text>4000). → **point-wrap 재발화 + 우리 content DOM 재작성이 VS Code relayout→width 16px collapse를 유발하는 것으로 의심**(미확정).

**진단 gap**: 기존 로깅은 collapse를 **periodic sweep으로 사후 발견**(`column-wrapper-detected`)할 뿐, (1) inline width=16px를 누가/언제 set하는지 (2) collapse 시작·종료(지속시간) (3) point-wrap/wrap과의 상관을 못 잡음.

**L72 계측 (동작 변경 없음, 순수 관찰)**:
- 새 he-event **`width-collapse-transition`** — style observer가 wrapper style mutation마다 rect를 보고 **collapsed↔normal 경계를 넘을 때만** 기록(volume bounded). 필드: `to`(collapsed/normal), `rect`, `inlineW/MaxW/H/Top/Left`(width set 주체), `hasDesired`/`initPositioned`, `innerTextLen`/`innerClasses`, `ptr`(x/y/ageMs/type), `msSincePointWrap`/`msSinceWrap`. **paired 이벤트로 collapse 지속시간 측정**.
- 상관 stamp 2개: `window.__irLastPointWrapAt`(point-wrap 시), `window.__irLastWrapAt`(navigable-name wrap 시).
- `column-wrapper-detected`(sweep)에 `msSincePointWrap`/`msSinceWrap` 추가(broad 커버).
- 새 kind `width-collapse-transition` force-log + forwarded 등록.

**v=225 측정에서 볼 것**:
- `width-collapse-transition to=collapsed`의 `inlineW`: `16px`면 inline set(VS Code/CSS), 빈 문자열이면 content-shrink(CSS `min-content`).
- collapsed→normal 간격 = collapse 지속시간(짧은 transient인지 고정인지).
- `msSincePointWrap`/`msSinceWrap`가 작으면(<~100ms) point-wrap 재발화/우리 wrap이 trigger.
- transition이 안 뜨고 `column-wrapper-detected`만 뜨면 → style mutation 아닌 content-shrink collapse → ResizeObserver 계측 추가 필요.

#### L72 검증 (v=225)
- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과(v=225, `width-collapse-transition`/`__irLastPointWrapAt`/`__irLastWrapAt`/`__irDiagCollapsed` 반영). E2E pillar/bar gate **1 passing**. 순수 관찰이라 동작 회귀 없음.

### L73 (width-collapse fix — 같은 심볼 재발화 억제) — 2026-05-29 (v=225 측정 후) — v=226

**v=225 측정 (L72 계측) — collapse 근본 원인 규명**. `width-collapse-transition` 8건:
- **16px collapse**: `inlineW=16px`(VS Code가 wrapper width clamp; 우리는 width 안 건드림) + `innerTextLen` 큼(내용 멀쩡) → wrapper만 clamp, ~500ms 후 회복.
- **0×0 collapse**: `inlineW=670px`(정상)인데 rect 0×0 → content swap 순간(일부 `msWrap=10`).
- `to=normal` inner=`[fade-in]`(VS Code 갓 만든 **새 엘리먼트**), `to=collapsed` inner=우리 `[ir-scrollable,…]`. raw: 같은 내용(text=1452)을 scan+wrap+size **1.8초에 4번** 반복.

**근본 원인 = 재발화 재렌더 루프**: 심볼 위 micro-move → hoverguard가 `outside-editor-token-relocation`으로 **release+native refire**(v=225 26건) → VS Code가 호버를 **새 .monaco-hover로 재렌더** → 우리가 `irMakeHoverScrollable` 재size(reflow) → reflow + VS Code width 재계산 = 16px/0×0 collapse. 기존 same-token 가드(line 4579 `irHoverContainsTokenText`, **텍스트 포함** 검사)는 hover 본문이 심볼명을 포함 안 하면 통과 못 해 재발화로 빠짐.

**L73 수정**: `irPointerWithinActiveHoverAnchor(e)` helper 신규(irHoverAnchorMoved 옆) — 포인터의 editor 위치가 현재 호버 anchor **word range**(`getPosition().range`, L71과 동일 개념) 안인지 검사. hoverguard `editorTarget` 블록 최상단에서 호출 → 같은 단어면 release+refire 대신 **호버 유지**(arm sticky + return). range 기반이라 (a) 텍스트 포함보다 신뢰성↑ (b) 다른 occurrence는 position 달라 range 불일치 → 정상 refire("first occurrence 고정" 회귀 없음). 불확실하면 false(보수적 — 필요한 refire 안 막음). 로그: `hoverguard outside-same-anchor-pass`.

#### L73 검증 (v=226)
- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과(v=226, `irPointerWithinActiveHoverAnchor`/`outside-same-anchor-pass` 반영). E2E pillar/bar gate **1 passing**.
- **runtime 측정 다음 세션 (최우선)**: 같은 심볼 좌우 이동 시 (1) 육안으로 width collapse 사라졌는지 (2) `width-collapse-transition` 빈도 급감 (3) `outside-same-anchor-pass` 등장 + `outside-editor-token-relocation` 급감 (4) **다른 심볼로 이동 시엔 정상 갱신**(회귀 확인). 잔존하면 MutationObserver 피드백 루프(scan dedup) 별도 처리(L74 후보).

### L74 (transient 0×0 "내용 안보임" fix — zero-rect dismiss 오판 방지) — 2026-05-29 (v=226 측정 후) — v=227

**v=226 측정 (L73) — L73 미발동 + 실제 dominant 원인 발견**:
- **`outside-same-anchor-pass`(L73 발동) = 0건**. L73는 `editorTarget`(포인터가 editor 위) 블록 안이라, 이 세션(클릭/hover 위 상호작용)에선 미발동. L73 자체는 유효(같은-심볼 refire-on-editor 케이스용)하나 dominant 경로가 아니었음.
- **`width-collapse-transition` 52건(↑)**: dominant는 **`0×0` with `inlineW=670px`**(width 정상인데 rect 0×0 = "내용 안보임"). 16px column은 소수.
- **핵심**: 0×0일 때 `textLen=1746~57808`(content 충분), `connected=true`, `visibilityReason=zero-rect`(display:block·visible인데 0×0) → **VS Code content swap 중 일시적 0×0 transient**(70ms 후 670×94 회복).
- raw 사이클: `0×0` → `native hover released retained hidden-active` → `native hidden hover cleaned` → `released native hover revived` → 회복. 즉 **우리 sweep(`irDisposeHiddenActiveHover`)이 transient 0×0을 dismiss로 오판해 release → revive 사이클**(cleaned 5, revived 12)을 돌려 flicker 증폭.

**근본 원인**: `irDisposeHiddenActiveHover`는 active hover가 not-visible이면 release/dispose하는데, **`zero-rect`(0×0이지만 content 있음)** 도 not-visible로 보고 release → VS Code가 회복시키려는 걸 우리가 방해 → release↔revive churn → "내용 안보임" flicker + 0×0 collapse.

**L74 수정**: `irDisposeHiddenActiveHover`에서 `visibility.reason==='zero-rect' && irHoverRootHasActivatingContent(active)`(content 있는 transient 0×0)면 release 안 하고 **bounded(10회) skip**(`__irZeroRectSkips`), VS Code 회복에 맡김. visible 회복 시 카운터 리셋. 진짜 stuck/empty면 10회 후 fall-through(release). 새 he-event `hidden-active-zero-rect-skip`(발동 측정용, force-log).

**효과**: transient 0×0을 우리가 release 안 하므로 release→revive churn 제거 → 0×0 flicker 격감 기대. VS Code 자체 transient(<1frame)는 남을 수 있으나 우리 증폭 없으면 거의 안 보임. 16px column(소수)은 별개 잔존 가능(VS Code wrapper clamp).

#### L74 검증 (v=227)
- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과(v=227, `hidden-active-zero-rect-skip`/`__irZeroRectSkips` 반영). E2E pillar/bar gate **1 passing**.
- **runtime 측정 다음 세션 (최우선)**: (1) 육안으로 "내용 안보임"/0×0 flicker 사라졌는지 (2) `hidden-active-zero-rect-skip` 발동(L74가 실제 engage하는지 — L73 0건 교훈) (3) `width-collapse-transition to=collapsed`(특히 0×0) 급감 (4) `released native hover revived`/`hidden-active cleaned` 급감 (5) 호버가 안 뜨는 회귀 없는지(L52류 — bounded skip이라 10회 후 release되므로 stuck 방지).

### L75 (DOM dedupe 임시 OFF — 가설 검증 실험) — 2026-05-29 — v=228

**사용자 가설**: "dedupe 로직이 만악의 근원. 사이즈 결정 중 dedupe가 프리징을 일으켜 hover 사이즈 복구를 중간에 끊거나 내용을 잘라먹는다." → **dedupe를 잠시 off하고 확인**.

**코드 근거 (`irDedupeHoverContent`, line 8926, scan의 9185에서 호출)**:
- 매 scan마다 각 `.rendered-markdown` 블록의 **전체 textContent(최대 ~57k자)에 정규식 5개**(`irNormalizeHoverDedupeText`) 실행 → 대형 hover가 MutationObserver 루프로 재scan될 때 **프리징**.
- duplicate 블록을 **DOM에서 제거**(`irRemoveDuplicateHoverBlock`) → 내용 잘라먹힘 가능.
- 제거 후 **wrapper shrink + `__irDesired` 재작성**(`irKeepMouseInsideWrapperAfterDedupe`, line 8974) → 방금 결정한 사이즈와 충돌(주석 L26: "after dedup the wrapper may have shrunk"). 사용자 증상과 정확히 일치.

**L75 변경**: `IR_HOVER_DOM_DEDUPE_ENABLED` `true→false` (line 8916). 1줄 토글, 기존 설계된 플래그. (extension-side `preview-dedupe.ts`는 render 전 단계라 size-determination 프리징과 무관 → 이번 실험 대상 아님. 필요 시 별도.)

**측정/판정 (v=228, L72/L74 진단 유지)**:
- dedupe off로 **0×0 "내용 안보임" / width collapse / 프리징이 사라지면 → 가설 확정**. 그땐 진짜 fix = dedupe를 **off가 아니라 paint 전 1회/내용당 1회**로(매 scan 금지) 재작성([[feedback_dedupe_before_paint]] 준수).
- 사라지지 않으면 → dedupe 아님, 다시 on(`true`) 복원 후 다른 경로.
- **부작용 주의**: dedupe off면 **중복 hover-preview 블록이 다시 보일 수 있음**(dedupe가 막던 것). 프리징/잘림이 사라지는지와 별개로 중복 등장 여부도 관찰.

#### L75 검증 (v=228)
- tsc + bundle 통과(v=228, `IR_HOVER_DOM_DEDUPE_ENABLED=false` 반영). E2E pillar/bar gate **1 passing**(dedupe와 무관 경로).

### L76 (reveal-when-settled staging — 형성 과정 숨기고 안정 후 1회 표시) — 2026-05-29 — v=229

**v=228 측정 (dedupe off)**: dedupe 제거 0건(off 확인, 가벼워짐) BUT **collapse 20건, force-preview-failed 12건, position-anomaly 5건 여전 + L74도 0건 발동**(L73에 이어 또). → **개별 transient 가드 접근이 계속 빗나감**(L73/L74 둘 다 미발동).

**사용자 방향 전환**: "호버를 너무 민감하게 띄울 필요 없으니, **500ms 예산으로 위치 계산 + 렌더 끝낸 뒤 보여주자**." → 형성(content 렌더+사이징+reposition)을 **숨기고**, 안정되면 **1회 reveal**. 불안정 상태(collapse/0×0/reposition jump)를 사용자가 아예 안 봄.

**L76 구현**:
- CSS `.monaco-resizable-hover.ir-hover-staging{visibility:hidden}` — `visibility:hidden`라 **레이아웃/사이징은 계속 진행**(rect 측정 가능), 화면엔만 안 보임.
- `irStageHover(wrapper)`: content sig(textContent 길이+샘플) 바뀌면 staging 세션 시작 — `ir-hover-staging` 추가 + `__irStageStart` 기록. **markdown observer의 `touchOnce`에서 트리거**(content 변경 시). sig 동일(우리 wrap/size mutation)이면 no-op, streaming 중 sig 변해도 budget clock은 첫 hide부터(무한 연장 방지).
- `irStageSettleCheck`(40ms poll): `width≥60 && height≥20 && content 있음 && 직전 대비 dims 안정(±2px)` → **settled → reveal**. `elapsed≥500ms → budget → reveal`(상한).
- `irStageReveal`: settled/budget 시 **reposition 1회 실행(위치 확정) 후** `ir-hover-staging` 제거. `hover-stage-reveal` he-event(reason+ms).
- **단일 choke point**: `irHoverRootVisibility`가 staged wrapper를 `{visible:true,reason:'staging'}`로 보고 → 기존 dispose/force-preview/unrenderable sweep(전부 이 함수 경유)이 staged hover를 **안 건드림**(staging과 충돌 방지).
- **Fail-safe (호버 안 뜸 방지)**: ① hard-cap 타이머(500+120ms) 무조건 reveal ② poll/함수 error 시 reveal ③ `irResetWrapperPositionState`(dismiss) 시 staging clear+reveal(early-return 前). 최악도 "500ms 후 표시"(영구 숨김 불가).
- dedupe는 off 유지(가벼움 + 형성 숨김으로 잔존 flicker 무관).

#### L76 검증 (v=229)
- tsc + bundle 통과(v=229, CSS/`irStageHover`/visibility 가드/`hover-stage-reveal` 반영). E2E pillar/bar gate **1 passing**.
- **runtime 측정 다음 세션 (최우선)**: ① `hover-stage-reveal` **발동(>0, reason 분포 settled vs budget)** — L73/L74처럼 0이면 트리거 안 걸린 것 ② 육안: collapse/0×0/위치 점프가 **형성 중 안 보이고** 안정된 호버가 한 번에 뜨는지 ③ **호버 안 뜸/지연 회귀 없는지**(reveal ms 분포 — 대부분 <500) ④ position-anomaly 감소.

### L77 (navigable-name wrap을 reveal 후로 defer — 형성 churn 제거) — 2026-05-30 — v=230

**v=229 측정 (L76 staging)**: staging **발동 확인**(`hover-stage-reveal` 43건 — L73/L74의 0건과 대조). 그러나 **budget 35(81%) / settled 8(19%)**, reveal ms median 511 = **81%가 500ms 꽉 채움**. 한 budget 윈도우(23:25:29): `wrap text=7773 wrapped=553`(navigable name 553개 삽입 = 대형 reflow) → collapse → budget reveal(아직 collapse) → reveal 후 reposition-skip-transient + unrenderable + "hover released" 8건. 즉 **staging이 증상을 500ms 지연만 시킴** — 대형 호버는 형성 churn이 500ms 내 안 끝남.

**근본 원인**: 형성 중 **navigable-name wrapping(수백 span 삽입)** → 대형 reflow + scan/size 피드백 루프 → wrapper collapse, settle 안 됨. settle 8건은 작은 호버.

**L77 수정 (사용자 선택 A)**:
- **staging 중 wrap skip**: `irScanRenderedMarkdown`에서 block의 wrapper가 `.ir-hover-staging`이면 `__irWrapDeferred=true` + `continue`(span 삽입 안 함). makeScrollable(사이징)은 그 전에 이미 실행돼 호버는 size 결정됨. **span 삽입이 없으니 sig 불변 → makeScrollable early-return → mutation 없음 → 피드백 루프 차단 → 빠른 settle → staging이 settled로 빨리 reveal**.
- **reveal 후 wrap**: `irStageReveal`이 `requestIdleCallback`(fallback setTimeout 60ms)로 `irScheduleScan()` 예약 → 호버가 표시·안정된 뒤 wrap 1회. wrapping은 textContent 불변이라 **re-stage 안 됨**(content sig 동일).
- 트레이드오프: click-navi 링크의 시각 표시가 reveal 직후 한 박자 늦게 붙음(클릭 자체는 `irWrapWordAtPoint` click-time fallback로 동작).

**효과 기대**: 형성에서 reflow 폭탄 제거 → 대형 호버도 빠르게 settle → `hover-stage-reveal reason=settled` 비율↑, budget(500ms 대기)↓, reveal 후 collapse/release↓.

#### L77 검증 (v=230)
- tsc + bundle 통과(v=230, wrap-defer gate + reveal-후 deferred wrap 반영). E2E pillar/bar gate **1 passing**. dedupe off + staging 유지.
- **runtime 측정 다음 세션 (최우선)**: ① `hover-stage-reveal` **reason=settled 비율↑** + ms median ↓(500 미만으로) ② 육안: 대형 호버도 빠르고 collapse 없이 한 번에 뜨는지 ③ reveal 후 collapse/release 사라졌는지 ④ navigable 링크가 reveal 직후 곧 붙는지(클릭 동작 확인).

### L78 (드릴 프리뷰 zero-rect 전멸 fix — transient 0×0 keepalive) — 2026-05-30 — v=231

**증상 (v=230 log.txt 분석)**: 드릴(hover 안 link 클릭→다음 심볼 프리뷰)이 `force preview hover visible failed reason=zero-rect` **28건 전부 실패, 회복 0건**. 같은 타깃(`zuzu.db.models.company`, 57k자)이 4회 반복 재시도 = 사용자가 드릴할 때마다 빈 화면.

**근본 원인 (시퀀스 01:10:47)**:
1. hover가 풀사이즈(680×513)로 visible → 타입 링크 530개 re-wrap(`wrap text=8421 wrapped=530`)
2. 그 도중 `width-collapse-transition → 0×0` (단 `inlineW:"612px" hasDesired:true` = **높이만 transient 붕괴**, content 멀쩡 textLen 131~57,566)
3. `irForcePreviewHoverVisible`이 un-hide 후 측정한 진짜 0×0을 **hard-fail(`return false`)** 반환
4. revive 경로가 실패로 읽음 → `irDisposeHiddenActiveHover`(line 6180)가 `irReleaseNativeHiddenHover`로 **release**(victim `reason=hidden-class` 12건) → "내용 사라짐"
5. L74 transient skip(`__irZeroRectSkips`, line 6170)은 진입 visibility가 `hidden-class`라 `zero-rect` 매칭을 비껴감 → **28건 내내 0건** 발동(`hidden-active-zero-rect-skip` 0건이 증거)

**L78 수정** (모든 revive/preview가 통과하는 단일 choke point에 L74식 관용):
- `irForcePreviewHoverVisible`(~line 5950): visibility 결과가 `zero-rect`+`irHoverRootHasActivatingContent`면 hard-fail 대신 — bounded(≤10회) keepalive(`__irForceZeroRectSkips`), `__irZeroRectTransientUntil=now+250ms` 스탬프, `requestAnimationFrame`로 reflow 재확인 예약, `return true`. 정상 visible 측정 시 카운터·grace 리셋.
- `irDisposeHiddenActiveHover`(release 직전, line 6180 위): `__irZeroRectTransientUntil`이 미래 + content 있으면 release **보류**(`return false`) → VS Code relayout(~70ms)으로 자연 회복.
- 검증용 he-event `force-preview-zero-rect-transient`(phase=force-keepalive/dispose-hold) + force-log 등록.

**왜 root force-visible로 안 되는데 keepalive면 되나**: 붕괴는 wrapper 레벨이라 root force-visible로 못 펴지만(→ L79), **release만 막으면** VS Code가 ~70ms 내 자체 relayout으로 회복. L78은 "죽이지 않고 기다리기"가 핵심.

#### L78 검증 (v=231)
- tsc 0 에러 + 템플릿 안전(추가 코드에 백틱/`${`/regex-backslash 없음). E2E pillar/bar gate 통과.
- **v=231 live 측정 → 성공**: `hidden-active-hoverguard` release **0건**(v=230 churn 경로 소멸), dispose-hold 17·keepalive 20, release는 정상 생명주기(active-switch 21/prune 23)로만. settled 19/29.
- **한계**: 남은 force-preview hard-fail 8건은 (a) 정당한 dismiss(클릭-어웨이/prune)거나 (b) wrapper가 16px로 stuck인 케이스 — 후자는 **L79 영역**. L78 자체 회귀(호버 안 뜸)는 bounded(10회/250ms)라 없음.

### L79 (16px 필러 wrapper-collapse fix — stuck inline width 복원) — 2026-05-30 — v=232

**v=231 측정으로 wrapper collapse를 두 종류로 분리** (신규 진단 `inlineDisplay`/`inlineVisibility`로 확정):
- **`rect 0×0` + `inlineDisplay:"none"`** (9건): hover 뚫고 에디터 다른 토큰 클릭/prune → `hide hover requested outside-editor-new-token` → 새 hover. inlineW가 실폭(670) 유지·display:none = **정당한 dismiss, 버그 아님** (L78이 처리).
- **`inlineW:"16px"` + `inlineDisplay:"block"`** (12건): `column-wrapper-detected`가 `innerTextLen>0` 캡처 = display:none 아닌 **live 세로 슬리버**. inline `width:16px`가 스타일시트 `min(max-content,680px)`를 덮어써 **스스로 복구 못 함**.

**증거 — 필러 stuck 지속시간 (v231 `width-collapse-transition` 타임라인)**: 08.701→14.187(5.5초), 18.148→23.636(5.5초), **32.234→48.966(16.7초!!)**. 그동안 사용자는 16px 세로 슬리버를 봄.

**기존 코드 문제**: `irScanNarrowHoverWrappers`(line 6647)는 이 필러를 감지(`column-wrapper-detected`)하지만 **우리 클래스만 제거하고 inline width는 복원 안 함** → 슬리버 그대로 (v231: detected 18 / cleaned 8).

**L79 수정**: 2-pass(≥200ms) 확정된 **콘텐츠 있는 column 필러**는 클래스 제거 대신 stuck inline `width`/`min-width`를 1회 제거 → 스타일시트 재확장. episode당 1회(`__irColumnWidthRestored`, style observer가 `to:normal`에서 리셋)로 VS Code resize와 프레임 단위 충돌 방지. 빈 shell·bar·1초 내 재붕괴는 기존 class-strip 폴백. **top/left 재핀 아님 → L69의 v=221 position-loop 회귀 회피**. 진단 보강(`inlineMinW/inlineDisplay/inlineVisibility`) + he-event `column-wrapper-width-restored`.

#### L79 검증 (v=232) — 부분 성공 + 진동 회귀
- tsc 0 에러. **작업 중 함정**: 패치 코드가 template literal 안에서 eval되므로 `\s`가 `s`로 붕괴(Node로 확인) → regex 대신 `.trim()`으로 회피.
- **메커니즘 작동 확인**: `column-wrapper-width-restored` 14건, `clearedInlineW:"16px"` → 회복 후 `inlineW=`(빈 값=스타일시트 인수) **600/680px로 확장**. 16px 슬리버가 읽을 수 있는 크기로 펴짐.
- **⚠️ 진동 회귀**: v231은 16px로 stuck(5~16초)이었으나 v232는 **16px↔600을 ~2초마다 진동**(flicker). 재붕괴 직전마다 `lazy-hover content mutation`(1225↔1254자) + `duplicate preview suppressed handle=79 source=pos-cache`. 즉 **같은 hover가 ~2초마다 재-preview/재렌더**(handle=79 21회·mutation 53회)되고 매 렌더가 16px를 거침. L79는 증상(16px)을 매번 펴주지만 **churn 자체는 못 막음**.
- **결론**: L79는 net 개선(영구 슬리버 → 대부분 읽힘)이나 flicker 잔존. **근본 해결은 상위 re-preview churn 억제**(#3 — 같은 심볼/handle 재발화, [[feedback_suppress_same_symbol_refire]] / `feedback_anchor_moved_compares_range`). churn을 막으면 필러·진동·staging budget(43%)이 한 번에 해소될 가능성.

### L80 (#3 근본원인 규명 + proactive width-freeze) — 2026-05-30 밤 — v=233

**v=232 측정으로 #3 근본원인 확정 (handover 가설 반증)**:

- `handle=79`가 같은 단어 anchor에서 **~2초마다 재발화**(15:55:50/52/54/56/58, 전부 `pos-cache` hit). 그 5연속 구간에 **`native show hover requested`/`irRequestNativeShowHover` 로그 0건** → **우리 renderer refire가 아니다.** (`irRequestNativeShowHover`는 발화 시 항상 extension에 로그를 남김 — 확인됨.)
- 재발화 직전 **1.4초 완전 침묵**(feedback loop 아님). `width-collapse-transition`의 `ptr ageMs=445`가 그 침묵 구간에 pointermove가 있었음을 증언 → **마우스가 같은 단어 안에서 천천히 드리프트(ptr.x 1363→1337→1317→1310) → VS Code의 ~300ms hover delay가 `$provideHover`를 재호출**.
- `posKey`는 `hoveredCandidate.anchor`(단어 시작) 기반이라 같은 단어 micro-move는 pos-cache hit. delivery dedup은 정상 작동(handover #3의 "발사 후 폐기"는 맞음).

**즉 handover #3 가설("진입 단계에서 우리 refire를 gate")은 틀렸다** — gate할 우리 refire가 없다. 재발화는 VS Code 내부라 직접 못 막고, `$provideHover`에서 `null` 반환은 hover dismiss 위험. (`feedback_suppress_same_symbol_refire`의 `irPointerWithinActiveHoverAnchor`(L73)도 `editorTarget` 블록 안 + 우리 refire용이라 이 경로엔 미발동.)

**flicker 메커니즘 (확정)**:
1. VS Code가 같은 anchor에서 `$provideHover` 재호출(pos-cache → preview는 정상 suppress).
2. 그래도 VS Code가 **hover DOM rebuild** → 우리 navigable-link span 42개 wipe(`mutation-childList 1254 links=0`, 직전 `1225 links=42`).
3. rebuild 중 inner 일시 narrow → 우리 `.monaco-resizable-hover{width:min(max-content,680px)}`가 **16px collapse**(`width-collapse-transition to=collapsed`).
4. 우리 re-wrap(1254→1225) + L79가 width 복원(16px→600px) → **~2초 주기 flicker**. content swap이 staging도 재트리거 → 매 사이클 `hover-stage-reveal budget(~500ms)` (호버가 ~2초마다 500ms씩 `visibility:hidden`) = budget 43%의 원인.

**L80 수정 (사용자 선택: 렌더러 width-freeze)** — 재발화는 못 막으니 **재렌더 중 폭 붕괴를 안 보이게**:

- `irFreezeWidth(wrapperEl,floorW)`: `min-width:floorW px !important` floor 적용. **min-width가 width를 이기므로** VS Code의 inline `width:16px`와 프레임 단위로 안 싸우고도 폭을 유지. `__irWidthFrozen` 플래그 + `width-freeze {phase:'hold',w}` 기록.
- `irScheduleWidthFreezeReleaseCheck`: rAF 루프로 inner `.monaco-hover` 폭을 확인(inner는 `width:max-content`라 floor에 안 늘어남 → 정직한 "content 재빌드됨" 신호). inner width≥60+text 있으면 `content-ready`로 floor 제거(`removeProperty('min-width')` → 스타일시트 재size). `IR_WIDTH_FREEZE_MAX_MS=600` 또는 40 frame 초과 시 `timeout`으로 fail-safe 해제.
- **freeze 트리거**: style observer(`irAttachStyleObserverToWrapper`)의 collapse-transition 감지부에서 `to:collapsed && dgR.width<60 && innerTextLen>0 && display≠none && __irLastGoodWidth≥60`이면 `irFreezeWidth`. (height-only bar는 제외 — min-width floor로 못 고침.)
- **last-good width 연속 추적**: style observer 매 콜백에서 `!dgCol && width≥60 && !frozen`이면 `__irLastGoodWidth=round(width)`.
- `irScanNarrowHoverWrappers`(L79)는 `__irWidthFrozen` wrapper를 skip(floor를 mid-hold에 안 떼게). 단 frozen은 width≥60이라 column 판정 자체가 안 됨 — 방어적 가드.
- `irResetWrapperPositionState`(dismiss): floor 제거 + `__irWidthFrozen`/`__irLastGoodWidth` 정리.
- 새 he-event `width-freeze`(force-log + forwarded).

**왜 staging budget도 풀리나**: content swap이 re-stage를 트리거해도, freeze로 폭이 ≥60 유지되면 `irStageSettleCheck`의 `notCollapsed(width≥60&&height≥20)`이 즉시 통과 → `hover-stage-reveal reason=settled(~80ms)`로 빠르게 reveal(기존엔 collapse라 budget 500ms 대기).

**안전성**: freeze는 `__irDesired`/style observer 있는 wrapper(=우리가 positioning한 VS Code content-hover)에만 도달 — 다른 extension overlay 무관. floor는 content-ready/timeout으로 bounded 해제라 "잘못된 폭으로 stuck" 불가. dismiss 시 정리. L79는 fallback으로 유지(freeze가 못 잡은 first-render 등).

**L79 E2E 회귀 발견·수정 (별건)**: L80 작업 중 E2E `pillar/bar gate`가 fail → **원인은 L80이 아니라 L79**(sweep 가드 제거하고 재측정해도 동일 실패). L79가 content-bearing column 필러를 class-strip→**width-restore**로 바꿨는데, 이 테스트(L48~L54용)는 옛 class-strip(keepalive 제거)을 기대. working tree에 L79 들어온 시점부터 이미 fail이었음(handover의 "L79 E2E 통과"는 stale `out/`로 측정한 듯 부정확). **수정**: `snapWrap`에 `widthRestored`/`inlineWidth` 추가, 시나리오1을 "2nd sweep이 width-restore + inline width clear + keepalive 보존"으로 갱신. bar(class-strip)·transient(보존) 시나리오는 불변. → **1 passing 복구**.

#### L80 검증 (v=233)
- `npx tsc -p ./ --noEmit` exit 0 + `npm run bundle` 통과(`RENDERER_PATCH_VERSION=233` + `irFreezeWidth`/`width-freeze`/`IR_WIDTH_FREEZE_MAX_MS`/`__irLastGoodWidth` 반영). 템플릿 리터럴 안전(추가 코드에 backtick/`${`/regex 없음).
- `IR_E2E_GREP="pillar/bar wrapper" npm run test:python` → **1 passing**, `col[widthRestored=true], bar[clean=true], trans[preserved=true]`.
- **runtime 측정 다음 세션 (최우선)**: (1) `width-freeze` **발동**(hold/release 분포 — L73/L74처럼 0이면 트리거 미스) (2) 육안: 같은 심볼에 오래 hover 시 16px↔정상 진동(flicker) 소멸 (3) `width-collapse-transition to=collapsed` + `column-wrapper-width-restored` 급감(freeze가 collapse를 선점) (4) `hover-stage-reveal` settled 비율↑/budget↓(43%→) (5) **회귀**: 호버 안 뜸/지연, 다른(더 좁은) 심볼로 이동 시 폭이 과도하게 넓게 stuck 안 되는지(release-by-content-ready 확인).

### L81 (#3 width-freeze re-hook — 검증된 경로로 + engagement 테스트) — 2026-05-30 밤2 — v=234

**v=233 측정 (L80 live)**: 새 세션(17:35, 973줄)에서 **`width-freeze` 0건 발동**. L73/L74/L80 모두 같은 "잘못된 경로" 함정.

근본: L80의 freeze 트리거가 **style observer**(`irAttachStyleObserverToWrapper`, wrapper의 `style` attribute mutation에만 발화)에 있었음. 그런데 v=233의 16px collapse는 **computed** — `width:min(max-content,680px)`가 VS Code 재빌드 중 inner 콘텐츠가 일시적으로 narrow해질 때 재계산된 값이지, inline-style write가 아님 → style observer가 transition으로 못 봄. 증거:
- style observer가 본 collapse **9건 전부 `rect:{w:0,h:0}` + `inlineDisplay:"none"`** = 정당한 dismiss(메모리 `project_collapse_is_wrapper_level`). 내 `display≠none` 가드가 올바르게 제외 → freeze 0건.
- 진짜 16px 기둥은 **sweep `column-wrapper-detected w:16` ×15**(content 184~59293자, ageMs 313~540ms 지속, ~2초 주기 재발) + **`initial-reposition-skip-transient rawW:16` ×6**(reposition 가드)가 감지. 둘 다 ResizeObserver/content-MO/sweep 경로 — style observer 아님.

**L81 수정**:
- **`irMaybeFreezeCollapsedWidth(wrapperEl)` 헬퍼로 freeze 결정 중앙화**: `display≠none` + `width<60 && height>40`(column, 0×0 dismiss·bar 제외) + inner 콘텐츠 있음 + `__irLastGoodWidth≥60`이면 `irFreezeWidth`.
- **검증된 3경로에서 호출**: (1) `irRepositionInitialHover` entry 가드(line ~2769) + post-measurement 가드(~2937) — RO/MO가 먹이는, 16px를 6건 목격한 경로. (2) `irScanNarrowHoverWrappers`(sweep, column 감지 직후) — 16px를 15건 목격한 최다 경로(backstop). (3) style observer(inline width:16px를 쓰는 v=232식 케이스 커버 유지).
- **lastGoodWidth 캡처**: style observer 연속 캡처 + `irRepositionInitialHover` 성공 측정 시(rawW≥60) 둘 다.
- **engagement E2E 추가**(harness `freeze` 시나리오 + 테스트 assertion): `__irLastGoodWidth=600` set한 content column을 sweep하면 `__irWidthFrozen=true` + `style.minWidth==='600px'`인지 검증 → **L80류 "0건 발동"을 live 없이 잡는 가드**.

**작업 중 함정 (기록)**: sweep 편집 때 `var cwInnerHasOurClasses=cwInnerClasses.some(...)` 선언을 실수로 함께 지움. `getHoverPatchScript()`가 template literal이라 **tsc가 못 잡음** → 런타임에 `if(cwInnerHasOurClasses)`가 ReferenceError → `irScanNarrowHoverWrappers`의 외부 try/catch에 삼켜져 **column 처리 전체가 조용히 skip**(seenAt 미설정) → E2E가 "must mark __irColumnSeenAt"로 실패. 디버그 계측(wrapsBeforeScan1 = 테스트 wrapper 단독 확인)으로 leftover 아님을 배제 후 선언 누락 발견·복원. **교훈: template-literal 안에서 기존 선언을 건드리는 편집은 런타임 ReferenceError 위험 — Edit old_string 범위 주의.**

#### L81 검증 (v=234)
- tsc 0 + bundle 통과(v=234). 템플릿 안전(추가 코드 backtick/`${`/regex 없음).
- `IR_E2E_GREP="pillar/bar wrapper"` → **1 passing**: `col[widthRestored=true], bar[clean=true], trans[preserved=true], freeze[frozen=true, minW=600px]`. **freeze 발동을 테스트가 직접 확인**(L80과 결정적 차이).
- **runtime 측정 다음 세션 (최우선)**: (1) `width-freeze` **hold/release 발동(>0)** — 0이면 또 미스(즉시 재조사). (2) `column-wrapper-detected w:16` / `column-wrapper-width-restored` / `width-collapse-transition to=collapsed` **급감**(freeze가 선점). (3) 육안 16px 진동 소멸. (4) staging settled↑/budget↓. (5) **회귀**: 다른(더 좁은) 심볼 이동 시 폭 과대 stuck 없는지(release-by-content-ready), 호버 안 뜸 없는지.
- **잔여 리스크**: sweep/RO는 reactive(16px paint 후 ~50-60ms)라 첫 collapse에 짧은 flash 가능 + release-on-content-ready라 churn 매 사이클 재freeze(잔여 flash). live에서 잔존 시 freeze 유지 시간 튜닝 검토.

### UI 시각 개선 (L58, L60)

| Patch | 내용 | 위치 |
|---|---|---|
| **L58** | `.monaco-resizable-hover`에 1px solid border (var(--vscode-editorHoverWidget-border) fallback chain) + border-radius 3px | renderer-patch.ts (옛 extension.ts ~line 10358) |
| **L60** | 2px로 확대 + fallback chain `focusBorder` 우선으로 (theme별 강조 색). border-radius 4px | 동일 |

## 모듈 refactor 현황 (Phase 2~16)

extension.ts는 한때 21,402 lines의 거대 단일 파일이었다. 점진적 phase 분리로 현재 **10,620 lines**까지 줄었고, 17개의 sibling module이 책임을 분담한다.

### Phase 2~14 (baseline, 이전 세션 작업)

| Phase | 모듈 | 역할 |
|---|---|---|
| 2 | `cache.ts` | def cache + not-found neg cache + click neg cache + preview click dedupe |
| 3a | `idents.ts` | SKIP_WORDS + declaration/decorator identifier scanners + addNavigableName |
| 3b | `preview-engine.ts` | DefinitionPreview interfaces + python/brace/decorator preview structural helpers |
| 4 | `preview-builder.ts` | preview location maps + buildDefinitionPreviewResult (+ FromRawFile variant) |
| 5 | `preview-markdown.ts` + `util.ts` | preview://markdown URI handling + workspace/language helpers + CODE_SCHEMES |
| 6 | `sidecar-resolve.ts` | Rust sidecar fast-path + import-target collection + python/TS resolution + fastResolveTypeName |
| 8 | `preview-dedupe.ts` | hover-preview block dedupe + IR_DIRECT_HOVER_MARKER + code-fence keys |
| 9 | `common-utils.ts` | withTimeout + open-document index (ensureOpenDocIndex/findOpenDoc) |
| 10 | `hover-deliver.ts` | hover preview delivery dedupe / suppress / primary-handle gating |
| 11 | `prefetch.ts` | document-open prefetch infrastructure + PASCAL_TOKEN memoization |
| 12 | `preview-history.ts` | drill-down history + scroll-restore scheduler + previewHistory stack |
| 13 | `hover-pending.ts` | pending-preview hover state machine + suppress-window logic |
| 14 | `native-refire.ts` | native-hover refire timers + lastHoverFetchPosition state |

### Phase 15a/15b/16 (오늘 작업)

| Phase | 모듈 | 역할 | extension.ts 영향 |
|---|---|---|---|
| **15a** | `cdp-discovery.ts` (213 lines) | process row 스캔 + isVSCodeMainProcessCommand + user-data-dir hint matching + findCurrentVSCodeMainPid (옵션 인자화) + httpGet + evaluateInspectorExpression + findInspectorWebSocketUrlForPid | −150 lines |
| **15b** | `cdp-eval.ts` (226 lines) | makeRendererEvalExpression + cdpRequest + findTestRendererWebSocketUrl + withRendererInputCdpSessionForTests. stale-main-socket / mainWsRef / test-mode 접근은 setter hook 3개로 wire-in | −139 lines |
| **16** | `renderer-patch.ts` (10,521 lines) | `getHoverPatchScript()` + `RENDERER_PATCH_VERSION`. 10,500-line JS-in-string은 byte-exact 복제. L48~L61 hover 로직 전부 이 파일에 격리됨 | **−10,782 lines** |

### Wire-in 패턴 (15b의 경우)

cdp-eval.ts는 extension.ts의 5개 module state(mainWsRef / mainWsRefIsRendererTarget / testRendererWebSocketUrlRef / isTestRendererDebugMode / closeMainWebSocket)에 의존했으나 모두 single-hook callback으로 wrap:

```ts
// extension.ts (activate() 직전, module top)
setCdpEvalLogger(log);
setCdpEvalStaleMainSocketHandler((ws, method) => {
  if (ws === mainWsRef && method !== 'Input.dispatchMouseEvent') {
    log.warn(`[cdp] ${method} timed out; dropping stale renderer CDP socket`);
    closeMainWebSocket();
  }
});
setCdpEvalEnv({
  getMainSocket: () => ({ ws: mainWsRef, isRendererTarget: mainWsRefIsRendererTarget }),
  isTestMode: () => isTestRendererDebugMode(),
  rememberTestRendererUrl: (url) => { testRendererWebSocketUrlRef = url; },
});
```

prefetch.ts / hover-deliver.ts 등 기존 phase에서 채택한 setter 패턴과 동일. 이후 phase에서 모듈 state coupling을 풀 때 그대로 따른다.

### Phase 16의 byte-exact 보존

```bash
# baseline 캡처 (10,500 lines, MD5 71c3dd1c34fc8a4ae0729991b3d1247f)
sed -n '9771,20270p' /tmp/extension-before-phase16.ts > /tmp/getHoverPatchScript.txt

# 변환 확인 (export prefix 한 줄만 다름)
diff <(sed '1s/^export function /function /' /tmp/extracted-body.txt) /tmp/getHoverPatchScript.txt
# → no output (ORIGINAL TEMPLATE MATCH)
```

template literal 내부 단 하나의 인터폴레이션 `${RENDERER_PATCH_VERSION}`은 renderer-patch.ts 내부에 같은 const(212)를 두어 그대로 동작. extension.ts 안에 남아있는 RENDERER_PATCH_VERSION 참조 3건(2266 / 2473 / 3546)도 import로 해결.

### 남은 추출 후보 (Phase 17+)

| 후보 | 위치 | 크기 | risk | 비고 |
|---|---|---|---|---|
| Import-follow engine | extension.ts L20417→21113(이전)/L8000→8617(현재) | ~700 lines | 중간 | esc helper + AbortError cross-ref. sidecar-resolve.ts와 분담 정리 필요 |
| Type detection + Go-to-def helpers | ~145 lines | 낮음 | findTypeNames + normalizeDef + AbortError + command-arg utilities | |
| 15c (renderer lifecycle: injectRenderer/reinjectRenderer/cleanup/startClickListener/evaluate*/dispatchNativeHover...) | ~1100 lines | **높음** | mainWsRef / extensionDeactivated / hoverPatchActive / 등 8+ module state. setter 폭증 |
| 15d (test harness `runHoverXxxHarnessForTests`) | ~5200 lines | 매우 높음 | lifecycle 위에 빌드 |
| V8 Inspector findSharedHoverService | ~50 lines | 낮음 | 가치 작음 |

권장 다음 phase: **Type detection + Go-to-def helpers** (low risk, 깔끔히 떨어짐) → **Import-follow engine** → 그 다음 15c sub-split.

### 다음 세션에서 반드시 할 일

1. ~~L66 + smoke test, L67~~ — ✅ 완료(위 섹션). L66 0회 발동, L67 효과 inconclusive.
2. ~~v=222 live 측정 (L69 column-collapse 확인)~~ — ✅ 완료(L70 섹션). **column fix 성공**(ageMs 278~598ms, 8초 고정 해소). 측정에서 짧은 호버 오거부+churn loop 발견 → **L70(v=223)** fix 완료.
3. ~~v=223 live 측정 (L70 확인)~~ — ✅ 완료(L71 섹션). L70 검증 OK(rawH=32 오거부 0, churn 0). 측정에서 char-단위 호버 follow 발견 → **L71(v=224)** fix 완료.
4. ~~v=224 live 측정 (L71 확인)~~ — ✅ 완료(L72 섹션). L71 작동(anchor-moved 0, char-follow 중단). 단 width=16px collapse 잔존 → **L72(v=225) 진단 계측** 추가.
5. ~~v=225 측정 + collapse 규명~~ — ✅ 완료(L73 섹션). 근본원인 = 같은심볼 재발화 재렌더 루프(`outside-editor-token-relocation` 26건). → **L73(v=226)** fix.
6. ~~v=226 측정 (L73 확인)~~ — ✅ 완료(L74 섹션). L73 미발동(0건). dominant = transient 0×0("내용 안보임") → `irDisposeHiddenActiveHover` 오판 release. → **L74(v=227)** fix.
7. ~~v=228 측정 (dedupe off)~~ — ✅ 완료(L76 섹션). dedupe off로 가벼워졌으나 collapse/내용없음/위치 여전 + L74 0건. → 방향 전환 **L76 staging**.
8. ~~v=229 측정 (L76 staging)~~ — ✅ 완료(L77 섹션). staging 발동(43)이나 81% budget + 형성 wrap이 churn 유발. → **L77(wrap defer)**.
9. ~~v=230 측정 (L77 staging)~~ — ✅ 완료. 측정 중 **드릴 zero-rect 전멸**(`force-preview … failed` 28건, 회복 0) 발견 → **L78(v=231)** fix.
10. ~~v=231 측정 (L78)~~ — ✅ 완료. **`hidden-active-hoverguard` release 0건 성공**. 측정에서 16px 필러 stuck(최대 16.7초) 분리 → **L79(v=232)** fix.
11. ~~v=232 측정 (L79 + 진동 감시)~~ — ✅ 1차 완료(현재 log.txt). `column-wrapper-width-restored` 14건·16px→600/680 회복 확인. **단 ~2초 진동(flicker) 회귀 발견** → 12번.
12. **#3 re-preview churn 억제 (진행 중)** — 근본원인 규명 완료(VS Code 내부 재호출). **L80(v=233) width-freeze는 0건 발동**(style observer wrong hook) → **L81(v=234): 검증된 경로로 re-hook + engagement E2E**(위 L81 섹션). **다음 세션 최우선: v=234 live 측정** — `width-freeze` 발동(>0)·16px 진동 소멸·settled↑. **0건이면 또 미스이므로 즉시 재조사**(다음 후보: ResizeObserver immediate 콜백에 직접, 또는 CSS min-width 접근). 옛 분석/명령은 아래 보존:
    ```bash
    V=232; LATEST=$(grep -nE "renderer\[w=[0-9]+ v=$V" log.txt | head -1 | cut -d: -f1)
    # 같은 handle 재-preview 빈도 (churn 원천)
    awk -v s="$LATEST" 'NR>=s' log.txt | grep "duplicate preview suppressed" | grep -oE 'handle=[0-9]+ source=[a-z-]+' | sort | uniq -c | sort -rn
    # content mutation 진동 횟수
    awk -v s="$LATEST" 'NR>=s' log.txt | grep -c "lazy-hover content mutation"
    # 필러 재붕괴↔복원 진동 (16px transition 수)
    awk -v s="$LATEST" 'NR>=s' log.txt | grep -c '"rect":{"w":16'
    ```
    - 가설: 같은 심볼/handle 재발화를 **진입 단계에서** 막아야 함(메모리 `feedback_suppress_same_symbol_refire` = 앵커 word range 게이팅, `feedback_anchor_moved_compares_range`). 현 dedup(`duplicate preview suppressed`)은 발사 *후* 폐기라 content mutation·collapse는 이미 발생.
    - 막히면 필러(L79 band-aid 불필요해질 수도)·진동·staging budget 동반 해소 기대.
13. **commit** (미실행, 사용자 요청 대기): L62~L81 + E2E(시나리오1 width-restore 갱신 + freeze engagement 시나리오) + handover. 경위: …→L79(16px 필러 width-restore)→L80(proactive width-freeze, #3, 0건 미발동)→L81(검증된 경로로 re-hook + 발동 E2E). **주의**: L79가 working tree에서 이미 E2E를 깨고 있었음(시나리오1 width-restore로 수정). commit 시 테스트 변경 포함.
14. (선택) Type detection + Go-to-def helpers 추출 (`Phase17` 후보).

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
- `column-wrapper-detected` — pillar/bar 발견 (shape: "column" | "bar"). **L72: `msSincePointWrap`/`msSinceWrap` 추가**
- `column-wrapper-cleaned` — 2-pass cleanup 발동 (ageMs)
- `wrapper-state-reset` — L48 reset 발동
- `hover-position-anomaly` — covers-cursor / far-from-cursor 진단 (drill 제외)
- **`width-collapse-transition`** ← L72. wrapper width/height가 collapsed↔normal 경계 넘을 때만. `to`/`rect`/`inlineW`(width set 주체)/`hasDesired`/`innerTextLen`/`innerClasses`/`ptr`/`msSincePointWrap`/`msSinceWrap`. paired 이벤트로 collapse 지속시간. **collapse 근본원인 규명용 — 해결 후 demote/retire 검토**
- `initial-reposition` / `initial-reposition-anchor-moved` 등 reposition audit
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

# Phase 16 byte-equivalence 재검증 (renderer-patch.ts 수정 시)
md5 /tmp/getHoverPatchScript.txt   # baseline = 71c3dd1c34fc8a4ae0729991b3d1247f
tail -n +22 src/renderer-patch.ts | sed '1s/^export function /function /' > /tmp/now.txt
diff /tmp/now.txt /tmp/getHoverPatchScript.txt && echo "STILL BYTE EXACT"
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
- **초기 hover positioning은 L62~L64에서 symbol-anchor로 능동 보정 중.** L57의 mouse-anchor 회귀 교훈: anchor는 symbol에서 가져온다 (mouse는 다른 token일 수 있음). Drill만 mouse-anchor.
- **L67: anchor 우선순위는 wrap-cache → `__irCapturedHoverWidget.getPosition()`(widget) → DOM fallback(픽셀).** 정지 첫 hover는 wrap-cache가 비므로 widget 직접 호출로 복구. widget은 재사용 singleton이라 세션 첫 캡처 이후 항상 유효.
- **L66은 def-lookup hover-on-hover엔 발동 안 함**(VS Code 단일 wrapper 재사용 — v=219 실측). peek/별도 tooltip 같은 진짜 분리 overlay 가드로만 유지. hover-on-hover의 anchor 없음은 L67 widget getPosition으로 처리되거나 no-natural-pos로 VS Code placement 유지.
- **L62~L64의 `irRepositionInitialHover`는 widget capture에 의존하지 않는다** (L64 DOM fallback + L67 widget singleton). 새 column / split editor에서도 작동.
- 진단 force-log `initial-reposition-skip` (reason 포함)은 stabilization 단계. 안정화 확인되면 `IR_HE_FORCE_LOG_KINDS`에서 forwarded-only로 demote (`initial-reposition` 성공 audit만 force-log 유지).

모듈 refactor 관련:

- **renderer-patch.ts는 byte-exact 보존이 원칙**. 안의 JS-in-string은 L48~L61 hover stability 표면 전체. 수정 시 위의 byte-equivalence 명령으로 baseline과 diff 비교 후 PR.
- **새 모듈 추가는 setter wire-in 패턴 따른다** (prefetch.ts / hover-deliver.ts / cdp-eval.ts 등 참고). extension.ts의 module state에 직접 import-back 금지 (circular 발생).
- extension.ts에 남은 `${RENDERER_PATCH_VERSION}` 인터폴레이션 3건(2266, 2473, 3546)은 import해서 쓰는 것 — version bump 시 renderer-patch.ts의 const만 수정하면 자동 반영.
- Phase 16 이후 extension.ts 라인 번호가 바뀌었으므로 L48~L61의 "위치" 주석(예: `~line 11083`)은 모두 **renderer-patch.ts 기준**으로 재계산 필요. (이 handover의 표는 옛 extension.ts 라인 번호 그대로 둠 — git diff 추적용)

## 남은 회귀 (미해결)

| 회귀 | 빈도 | 상태 |
|---|---|---|
| **width 좁아짐 (16px column 붕괴)** (호버 폭이 세로 기둥으로 좁아짐) | v=221: column 40건(62% `__irDesired` 부착), 8초 고정 | **L69(v=222) fix 확인됨** — v=222 측정에서 column이 ageMs 278~598ms로 정리(8초 고정 해소). collapse 가드 2개로 붕괴 중 hands-off |
| **짧은 호버 오거부 + churn loop** (height≤60 호버 reposition 안 됨 / 한 frame 23개 skip-transient 폭발) | v=222: `skip-transient rawW=670 rawH=32` 32건, `initial-reposition` 성공 최소 height=94 | **L70(v=223)가 fix — v=223 측정으로 확인됨** (rawH=32 오거부 0, hoverH=32 success, churn 폭발 0). transient 가드 4곳 height `<60`→`<20` 정렬 |
| **char-단위 호버 follow** (같은 심볼 내 좌우 이동 시 호버가 char마다 따라옴) | v=223: anchor-moved reposition이 토큰 폭 안에서 반복 | **L71(v=224)가 fix — v=224 측정 확인됨**(anchor-moved 0건, follow 중단). `irHoverAnchorMoved`를 word range 비교로 변경 |
| **collapse / 0×0 "내용 안보임" / 위치 점프 (형성 중 flicker, dominant)** (호버가 뜨는 동안 폭 붕괴·내용없음·위치 튐) | v=226/228: collapse 20+, force-preview-failed 12, position-anomaly 5. 개별 가드(L73/L74) 둘 다 0건 — whack-a-mole 실패 | **L76 staging + L77 wrap-defer가 근본 타겟** — 형성을 숨기고(L76), 형성 중 wrap(reflow 폭탄)을 defer해(L77) 빠르게 settle 후 1회 표시. v=229: staging 발동(43)이나 81% budget(churn) → L77로 churn 제거. **v=230 live로 settled↑/budget↓/reveal 후 collapse↓ 확인** |
| ~~transient 0×0 release 오판 (L74)~~ | v=226 | L74(zero-rect+content skip) 추가했으나 **v=228 0건 발동** — sweep 경로가 예상과 달랐음. L76 staging이 상위에서 흡수(staged=visible로 dispose 자체 skip). L74는 잔류(무해) |
| **간헐 width=16px column (소수)** | v=226: `16x272 inlineW=16px` 소수 | L73 재발화 억제가 일부 도움(같은심볼-on-editor). 잔존하면 VS Code wrapper clamp transient — L69/L70 hands-off로 흡수. dominant 아님 |
| ~~같은 심볼 재발화 재렌더~~ | v=225 26건 | **L73(v=226)** 가드 추가(미발동 측정 — 유효하나 dominant 경로 아니었음). 다른심볼-on-editor 케이스용으로 유지 |
| **드릴 프리뷰 zero-rect 전멸** (`force preview … failed reason=zero-rect`, 회복 0) | v=230 분석: 28건 전부 실패, release churn(내용 사라짐) | **L78(v=231) fix 확인됨** — transient 0×0(content 있음)을 hard-fail 대신 bounded keepalive + dispose release 보류. **v=231 `hidden-active-hoverguard` release 0건**. (L74가 0건이던 건 진입 visibility=hidden-class라 zero-rect 매칭 빗나감) |
| **16px 세로 필러 (wrapper-collapse)** (호버 폭이 읽을 수 없는 세로 슬리버로, inline `width:16px`·display:block·content 있음) | v=231: 최대 16.7초 stuck. detected 18/cleaned 8 | **L79(v=232) 부분 fix** — 콘텐츠 있는 column 필러의 stuck inline width를 1회 제거→스타일시트 재확장(width-restored 14, 600/680 회복). **단 진동 회귀**(아래 churn). 0×0(=`inlineDisplay:none` dismiss)과 구분 |
| **re-preview churn → 진동/budget (#3)** (같은 hover가 ~2초마다 재-preview→content mutation→16px 재붕괴, L79가 매번 펴줘 flicker) | v=232: churn 21회; v=233: 16px 기둥 15건(313~540ms, content) | **근본원인 확정 = VS Code 내부 재호출**(마우스 드리프트+~300ms hover delay, 우리 refire 0건). **L80(v=233) width-freeze는 0건 발동**(style observer가 computed collapse 못 봄). **L81(v=234): 검증된 경로(reposition 가드·sweep)로 re-hook + engagement E2E**. **live 측정 미완** — v=234에서 `width-freeze` 발동·16px 진동 소멸 확인 필요 |
| **content swap 시 위치 고정** (호버 떴을 때 다른 심볼로 빠르게 이동 → content는 바뀌나 위치 옛 심볼) | v=220 사용자 보고 | **L68(v=221)이 타겟**. style observer가 옛 `__irDesired`를 4초 재적용 + one-shot이 reposition 차단하던 것을, `irHoverAnchorMoved`로 anchor 변화 감지해 새 심볼로 재배치. v=221 육안+telemetry 확인 필요 |
| 정지 상태 첫 hover가 cursor 덮음 | v=219: 18 → v=220: 2 (편차 가능) | L67 타겟이나 v=220에서 `posSrc=widget` 0건 — **효과 inconclusive**. v=221에서 계속 관찰 |
| ~~hover-on-hover가 cursor 덮음 / 멀리 뜸~~ | — | **재평가됨**(v=219). VS Code 단일 wrapper 재사용 → def-lookup hover-on-hover는 content swap, foreign overlay 부재. L66 0회. 별도 회귀 아님 |
| L68 미커버: live anchor 못 읽음(`__irCapturedHoverWidget` null/position 없음) | 미측정 | 감지 실패 시 옛 pin 동작 유지. 희귀 |
| hover-on-hover에서 widget getPosition anchor 오용 가능성 | 미측정 | content swap hover가 엉뚱한 editor pos 주면 reposition 회귀. v=221 `posSrc=widget` + anchor-moved 분포로 감시 |
| scroll-restore re-fire null anchor error | 드물게 1건/세션 | 별도 issue, hover position과 무관 |

**측정 다음 세션 우선순위 (v=221)**:

1. **(L68 핵심)** 육안: 호버 뜬 상태에서 다른 심볼로 빠르게 이동 시 위치가 새 심볼로 따라오는지. + `initial-reposition-anchor-moved` 발동 분포(`via` 별):
   ```bash
   awk -v s="$LATEST" 'NR>=s' log.txt | grep "he-event initial-reposition-anchor-moved" | grep -oE '"via":"[^"]*"' | sort | uniq -c
   ```
2. anchor-moved가 같은 hover에서 폭증하지 않는지(재진입/루프 의심) — 시간 간격 확인.
3. (L67 계속) `posSrc=widget` 회수율, `no-natural-pos` 추이, `hover-position-anomaly covers-cursor` 변화.

## 컴파일/빌드

```bash
npx tsc -p ./ --noEmit   # type check만
npm run bundle           # tsc + esbuild 둘 다
```

L48~L68 + E2E + Phase 15a/15b/16 반영 모두 type-check + bundle 통과 확인됨 (2026-05-29). E2E runtime smoke test(pillar/bar gate) 통과. 다음 세션 첫 작업: v=221 live 측정(L68 content-swap 위치 추종 육안 + `initial-reposition-anchor-moved` 분포) + (사용자 요청 시) commit.

**주의 — template literal escape 함정**: `renderer-patch.ts`의 `getHoverPatchScript()` 본문은 backtick (`` ` ``)으로 감싼 단일 template literal. 안에 추가하는 JS 코드 / 주석에 backtick 들어가면 template 닫혀서 tsc TS1005 error. 일반 인용은 `'`, `"` 또는 `─`/`—` 사용. (L63a 작업 중 1회 발생, 즉시 수정).

## 다음 세션 측정 명령 (generic)

새 log.txt 받으면 항상: **마지막 activate 이후 = 새 세션** 으로 구간을 잡고 현재 build version으로 필터.

```bash
# 새 세션 구간 (마지막 activate 이후) + 현재 build version 확인
LAST_ACT=$(grep -nE "activating\.\.\." log.txt | tail -1 | cut -d: -f1)
awk -v s="$LAST_ACT" 'NR>=s' log.txt | grep -oE "renderer\[w=[0-9]+ v=[0-9]+" | grep -oE "v=[0-9]+$" | sort | uniq -c   # 버전 분포
V=234; LATEST=$(grep -nE "renderer\[w=[0-9]+ v=$V" log.txt | head -1 | cut -d: -f1)   # V를 측정 대상 build로

# ★ 현재 핵심 #3 / L81: width-freeze가 발동하나 (L80은 v=233에서 0건 = wrong hook이었음)
awk -v s="$LATEST" 'NR>=s' log.txt | grep "he-event width-freeze" | grep -oE '"phase":"[^"]*"' | sort | uniq -c   # hold/release 발동 (0이면 또 트리거 미스 — 즉시 재조사)
awk -v s="$LATEST" 'NR>=s' log.txt | grep -c '"rect":{"w":16'   # 16px 필러 재붕괴 횟수 (L80 후 급감 기대)
awk -v s="$LATEST" 'NR>=s' log.txt | grep "width-collapse-transition" | grep -c '"to":"collapsed"'   # collapse 진입 횟수 (freeze가 선점하면 급감)
awk -v s="$LATEST" 'NR>=s' log.txt | grep -c "column-wrapper-width-restored"   # L79 reactive 복원 (freeze가 선점하면 급감)

# 참고: churn 재발화 자체는 VS Code 내부라 안 줄어듦 (L80은 재렌더를 invisible하게 함)
awk -v s="$LATEST" 'NR>=s' log.txt | grep "duplicate preview suppressed" | grep -oE 'handle=[0-9]+ source=[a-z-]+' | sort | uniq -c | sort -rn   # 같은 handle 재발화 (참고용)
awk -v s="$LATEST" 'NR>=s' log.txt | grep -c "lazy-hover content mutation"   # content 진동 횟수

# L78 검증: 드릴 release churn 사라졌나 (0이 목표)
awk -v s="$LATEST" 'NR>=s' log.txt | grep -c "native hover released.*hidden-active-hoverguard"
awk -v s="$LATEST" 'NR>=s' log.txt | grep "force-preview-zero-rect-transient" | grep -oE '"phase":"[^"]*"' | sort | uniq -c   # keepalive/dispose-hold 발동

# L79 검증: 필러 width 복원됐나 + 0×0(dismiss) vs 16px(필러) 구분
awk -v s="$LATEST" 'NR>=s' log.txt | grep -c "column-wrapper-width-restored"   # 필러 복원 발동
awk -v s="$LATEST" 'NR>=s' log.txt | grep "width-collapse-transition" | grep -oE '"rect":\{"w":(0|16)[^}]*\}.*"inlineDisplay":"[^"]*"' | grep -oE '"inlineDisplay":"[^"]*"' | sort | uniq -c   # none=dismiss / block=필러

# staging(L76)/wrap-defer(L77) 효과 (budget↓ 목표 — churn 막히면 동반 개선)
awk -v s="$LATEST" 'NR>=s' log.txt | grep "hover-stage-reveal" | grep -oE '"reason":"[^"]*"' | sort | uniq -c   # settled(빠름) vs budget(500ms 대기)
awk -v s="$LATEST" 'NR>=s' log.txt | grep -c "he-event hover-position-anomaly"

# he-event 분포 일괄 (정확 매치)
for K in width-freeze hover-stage-reveal width-collapse-transition initial-reposition initial-reposition-anchor-moved hover-position-anomaly column-wrapper-detected column-wrapper-width-restored force-preview-zero-rect-transient hidden-active-zero-rect-skip; do
  echo "  $K: $(awk -v s="$LATEST" 'NR>=s' log.txt | grep -cE "he-event $K( |\"|$)")"
done
```

**판정 기준 (v=234 현재)**: ① **L81(최우선)** — `width-freeze` hold/release **발동(>0)**. v=233에서 L80이 0건이었으므로 이게 첫 확인 포인트. 발동하면 `column-wrapper-detected w:16`·`column-wrapper-width-restored`·`width-collapse-transition to=collapsed` **급감** + 육안 16px 진동 **소멸** 기대. ② `hover-stage-reveal` settled↑/budget↓(v=233 settled 26/budget 15=63%). ③ **L78** — `hidden-active-hoverguard` release = 0 유지. **회귀 체크**: 호버 안 뜸/지연, **다른(더 좁은) 심볼 이동 시 폭 과대 stuck 없는지**(freeze release-by-content-ready), navigable 링크 클릭. 참고: churn 재발화(`handle=` 다수)는 VS Code 내부라 안 줄어듦 — L81은 재렌더를 invisible하게 하는 것.

## 파일 맵 (현재 src/)

```
extension.ts        10,620 lines — activate/deactivate, registerHoverProvider, $provideHover patch, renderer injection lifecycle, harness test functions, V8 inspector, type/go-to-def/import-follow handlers
cache.ts            def cache + neg caches + click dedupe
cdp-discovery.ts    process row 스캔 / inspector WS discovery (Phase 15a)
cdp-eval.ts         CDP request/eval primitives + test-renderer WS (Phase 15b)
common-utils.ts     withTimeout + open-doc index
hover-deliver.ts    hover preview delivery dedupe / primary-handle 게이팅
hover-pending.ts    pending-preview hover state machine + suppress window
hover-state.ts      pos-preview cache (per position)
idents.ts           SKIP_WORDS + declaration/decorator identifier scanners
indexManager.ts     Rust sidecar process manager (이전부터 별도)
native-refire.ts    native-hover refire timers + lastHoverFetchPosition
prefetch.ts         document-open prefetch + PASCAL_TOKEN memoization
preview-builder.ts  preview location maps + buildDefinitionPreviewResult
preview-dedupe.ts   hover-preview block dedupe + code-fence keys
preview-engine.ts   DefinitionPreview interfaces + structural helpers
preview-history.ts  drill-down history + scroll-restore scheduler
preview-markdown.ts preview://markdown URI handling
renderer-patch.ts   ~11,300 lines — getHoverPatchScript() 거대 JS-in-string (L48~L81 hover stability + position 표면, Phase 16). RENDERER_PATCH_VERSION = 234 (L81 width-freeze re-hook[검증된 경로]·L80 proactive width-freeze[#3] + L79 16px 필러 width-restore + L78 드릴 zero-rect keepalive + L77 wrap defer + L76 staging + L75 dedupe OFF — 실험 묶음; v=234 측정 후 확정/조정). ★ 전체가 template literal이라 추가 코드에 backtick/`${`/단일-backslash regex(`\s`→`s` 붕괴) 금지 + **기존 `var` 선언을 지우면 런타임 ReferenceError(tsc 못 잡음)**
sidecar.ts          sidecar type definitions (이전부터 별도)
sidecar-resolve.ts  Rust sidecar fast-path + import 해석
util.ts             workspace/language helpers + CODE_SCHEMES
```
