# 개발 안내

## 도구와 타입 경로

이 패키지는 `package.json`의 `packageManager`에 선언된 `bun@1.3.14`를 사용합니다. Pi 타입은 devDependency `@earendil-works/pi-coding-agent`와 `@earendil-works/pi-tui`의 `node_modules` 설치본에서 해석됩니다. 개발 의존성 범위는 `^0.84.1`이지만 optional peer dependency는 `*`이므로 소비자의 Pi 최소 버전을 메타데이터로 강제하지 않습니다.

```bash
bun install
bun run lint
bun run lint:fix
bun run check
bun run test
bun run ci
bun pm pack --dry-run
```

`ci`는 Biome lint, 타입 검사, 테스트를 순서대로 실행하며, 변경을 검증된 것으로 취급하기 전에 반드시 통과해야 합니다. `lint:fix`는 Biome이 안전하게 고칠 수 있는 형식을 적용합니다. `pack --dry-run`은 배포하지 않고 패키지 포함 파일을 확인합니다.

## 프로젝트 구조

```text
index.ts                — 안정적인 Pi 확장 진입점, package.json의 pi.extensions가 참조
src/types.ts            — 질문·옵션·답변·취소 사유·결과의 공유 값 타입
src/questions.ts        — typebox 파라미터 스키마와 신뢰할 수 없는 입력 정규화
src/sanitize.ts         — 모델 제공 표시 문자열과 사용자 입력의 안전 처리·길이 제한
src/state.ts            — 탭·커서·필터·다중 선택·답변·오류·단발 확정 상태 머신
src/render.ts           — 폭 계산, 뷰포트, 매달린 들여쓰기, 옵션·요약 문자열의 순수 포매팅
src/keys.ts             — Pi 키 바인딩 해석과 기본값 대체
src/component.ts        — 상태 머신을 Pi TUI에 연결하는 키 처리·편집기·테마 렌더링
src/presence.ts         — 선택적 process-local presence producer
src/tool.ts             — ask_user 도구 등록, 결과 형성, 취소 처리
test/questions.test.ts  — 정규화, 기본값·범위·크기 제한, 오류 메시지, 스키마 제약 테스트
test/sanitize.test.ts   — 표시 문자열 정제와 code-point 절단 테스트
test/state.test.ts      — 탭·커서·필터·다중 선택·자유 입력·단발 확정 상태 전이 테스트
test/render.test.ts     — 폭 경계, 뷰포트, 들여쓰기, 옵션·요약·도움말 문자열 테스트
test/keys.test.ts       — 사용자 키 바인딩, 표시 레이블, fallback 테스트
test/component.test.ts  — 실제 pi-tui 편집기와 fake TUI/theme으로 키 입력부터 렌더 출력까지 검증
test/presence.test.ts   — 게이트 조건, payload 형식, 순서 필드, 실패 격리, 개인정보 canary 테스트
test/tool.test.ts       — 오류 결과, 결과 텍스트, 호출 라벨 포매팅 테스트
test/entrypoint.test.ts — 등록 표면, 비대화형 경로, 완료·취소·abort 경로, 렌더러 테스트
test/helpers/           — fake theme·fake TUI, 정규화 기본값 질문 factory(`question.ts`), 외부 구현에 의존하지 않는 canonical presence 소비자 profile fixture
docs/                   — 주제별 문서
```

루트 `index.ts`는 그대로 둡니다. `package.json`의 `pi.extensions`가 이 파일을 확장 진입점으로 참조하기 때문입니다. `src/`는 하위 디렉터리 없이 평면 구조이며 각 모듈이 타입·검증·상태·포매팅·렌더링·presence·도구 등록 중 하나의 책임만 갖습니다.

의존 방향은 `types`·`sanitize` → `questions` → `render` → `state` → `component` → `tool` → `index`이며 `keys`는 `component`만, `presence`는 `tool`만 사용합니다. `questions`, `sanitize`, `render`, `state`는 실제 터미널 없이 검증할 수 있습니다. `render`는 ANSI 폭 계산을 위해 `pi-tui` 유틸리티를 사용하지만 TUI 컴포넌트를 만들지 않습니다.

## 변경 불변 조건

- 신뢰할 수 없는 도구 인수는 UI를 열기 전에 `normalizeQuestions`에서 검증합니다. 오류는 예외가 아니라 문자열로 반환하고 취소된 결과로 보고합니다.
- 모델이 제공한 표시 문자열은 `normalizeQuestions`에서 정제하며, 그 아래 단계는 이를 다시 검사하지 않습니다. 다만 정규화 전 도구 호출 줄과 정규화된 `details`가 없는 결과 텍스트는 `src/tool.ts`에서 직접 정제합니다.
- 답변 의미는 `src/state.ts`에만 둡니다. `src/component.ts`는 키를 상태 전이로 옮기고 스냅샷을 그리는 역할만 합니다.
- 필터 중에도 답변은 보이는 행이 아니라 원래 옵션 위치로 식별합니다. 필터·뷰포트·숫자 조작을 바꿔도 선택의 `index`와 값이 달라지면 안 됩니다.
- 다중 선택의 자유 입력 추가분은 하나의 선택으로 계산합니다. 최소·최대 범위 검사, 카운터, 확정 답변이 모두 같은 계산을 써야 합니다.
- 확정은 단발입니다. `submit`이 여러 번 호출되어도 결과 콜백은 한 번만 실행되어야 합니다.
- 취소는 순서에 의존하지 않아야 합니다. abort가 컴포넌트 mount 전에 도착해도 취소로 수렴해야 하고, 컴포넌트는 그대로 반환해 host가 정리할 수 있어야 합니다.
- `id`는 공백 제거 후 비교·저장합니다. 다른 사용자 제공 문자열은 자동으로 `trim`하지 않습니다. 예외는 저장 시점의 자유 입력 답변입니다.
- 렌더 결과는 요청한 폭을 넘지 않아야 합니다. 새 표시 문자열을 추가하면 `wrapLines`/`wrapLinesWithPrefix`를 통과시킵니다. 옵션 뷰포트는 터미널 높이에서 3–10행으로 계산합니다.
- 렌더 캐시는 폭과 상태 revision을 함께 키로 씁니다. 새 상태를 추가하면 변경 시 `revision`이 증가하도록 합니다.
- 사용 가능한 `KeybindingsManager`가 있으면 `tui.select.up`/`down`/`confirm`/`cancel` 바인딩이 권위 있습니다. 관리자가 바인딩하지 않은 키는 동작하지 않으며, 관리자 부재·오류와 "해당 동작에 바인딩된 키가 하나도 없는 경우"에만 기본 키로 대체합니다. 마지막 예외는 모달 프롬프트에서 확인 키가 사라져 답변이 불가능해지는 상황을 막기 위한 것이고, 이때 도움말도 대체한 키를 표시해 표시와 동작을 일치시켜야 합니다.
- 자유 입력 편집기는 `tui.select.confirm`이 아니라 `tui.input.submit`으로 제출합니다. 편집기 도움말은 실제로 제출되는 키를 표시해야 합니다.
- 편집·필터 중이 아닌 질문 화면의 `Esc`는 바인딩 설정과 무관하게 항상 설문을 취소하는 escape hatch여야 합니다.
- 라이브로 렌더링되는 필터 텍스트와 자유 입력 편집기 버퍼는 답변 기록 시점뿐 아니라 입력 시점에도 제어·bidi 문자를 제거하고 각각의 길이 제한을 적용해야 합니다. 편집기 버퍼를 다시 쓰는 것은 실제로 위험하거나 길이를 초과한 입력에만 한정합니다. `setText`는 커서를 끝으로 옮기고 undo 스냅샷을 남기므로 입력마다 호출해서는 안 됩니다.
- 다중 선택 자유 입력이 최대 개수를 넘겨 거부되면 입력을 저장하지 않고, 이전에 확정된 답변도 함께 지웁니다. 검토 탭이 사용자가 이미 벗어난 값을 제출할 수 있으면 안 됩니다.
- presence는 관찰용입니다. 이벤트 발행 실패, 소비자 부재, 잘못된 세션 ID가 질문 실패로 이어져서는 안 됩니다.
- presence payload에 질문·옵션·답변 내용을 넣지 않습니다. 새 필드를 추가하면 [`configuration.md`](configuration.md)의 개인정보 범위와 canary 테스트를 함께 갱신합니다.
- 도구는 `sequential` 실행 모드를 유지합니다. 동시 질문이 TUI를 경합하지 않게 하기 위한 것입니다.

## 검증 범위

`bun run ci`는 먼저 `biome check .`로 lint를 실행한 뒤, 입력 정규화와 오류 메시지·크기 제한·기본값·선택 범위, typebox 스키마 제약, 표시 문자열 정제와 code-point 절단, 탭·커서·필터·뷰포트·다중 선택·자유 입력 상태 전이, 단발 확정, 폭 경계와 들여쓰기, 옵션·요약·도움말 문자열, 사용자 키 바인딩과 기본값 대체, 실제 `pi-tui` 편집기를 사용한 키 입력·렌더 출력, presence 게이트·payload·순서 필드·실패 격리·개인정보 canary, 도구 등록 표면과 비대화형·완료·취소·abort 경로, 호출·결과 렌더러를 실행합니다.

### 결정론적 호환성 근거

`test/helpers/presence-consumer.ts`의 canonical V1 consumer profile은 외부 저장소를 import하거나 실행하지 않는 로컬 fixture입니다. capability가 없는 일반 cmux-style profile과 `presence-remove-v1`을 광고하는 Herdr-style profile을 각각 consumer-first·producer-first 발견/광고/replay 흐름에 넣습니다. 두 profile 모두 exact V1 update/remove shape, 개인정보 필드 부재, 그리고 실제 질문 완료 뒤 remove가 한 번 발행되는지를 검증합니다. 이는 producer가 V1 계약을 지키는지에 관한 반복 가능하고 결정론적인 근거이며, 소비자 구현의 동작을 대체하지는 않습니다.

### 라이브 연동 범위

이 검증은 fake TUI와 fake theme 및 위의 로컬 protocol fixture까지만 다룹니다. 실제 터미널 렌더링, 실제 테마 색상, 실행 중인 `pi-cmux-presence`·Herdr와의 연동, cmux 서버·socket·CLI·polling 동작은 검증하거나 구현하지 않습니다. 변경 후 실제 환경에서 확인할 항목은 좁은 터미널에서의 줄바꿈, 편집기 커서 표시, 설치된 presence 소비자가 있을 때의 알림 동작입니다.

## 관련 문서

- [`usage.md`](usage.md) — 도구 호출 형식, 검증 규칙, 반환 형식
- [`configuration.md`](configuration.md) — presence 이벤트 계약과 개인정보 범위

## 문서 작성 방식

- `README.md`는 짧고 신호가 높은 진입 문서로 유지합니다.
- 자세한 동작은 주제별 문서에 둡니다.
- 전체 구현 목록보다 안정적인 개념을 우선합니다.
- 중복된 명령 목록은 최소화하고 `package.json`과 맞춥니다.
- 사람이 읽는 문서(`README.md`, `docs/*.md`)는 한국어로, 에이전트가 읽는 문서(`AGENTS.md`)는 영어로 씁니다.
