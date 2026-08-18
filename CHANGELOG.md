# 변경 이력

## Unreleased

### 추가

- 질문 필드 확장. `optional`(건너뛰기 행과 `skipped` 답변), `requireReview`(단일 질문도 검토 탭을 거침), `defaultValues`(옵션 값 미리 선택·커서 배치), `minSelections`/`maxSelections`(다중 선택 개수 범위), `otherLabel`·`otherPlaceholder`·`otherMaxLength`(자유 입력 표시와 길이 상한)를 추가했습니다.
- 다중 선택과 자유 입력을 함께 사용할 수 있습니다. `multi` 답변에 `custom` 필드가 추가되며, 입력한 텍스트는 선택 하나로 계산됩니다.
- 긴 목록 탐색. 화면 높이에 맞춘 옵션 창과 `↑ N more`/`↓ N more` 표시, 숫자 키 1–9 즉시 선택, `/` 필터(레이블·값·설명 대소문자 무시), 다중 선택 전체 선택(`a`)·해제(`c`)를 추가했습니다.
- 결과 텍스트에 기계값을 함께 담습니다. `Runtime: Bun [bun]` 형태이며 값이 레이블과 같으면 생략합니다.
- `cancelReason`(`user`/`aborted`/`unavailable`/`invalid`)을 결과에 추가하고 취소 텍스트에 사유와 그때까지의 답변을 담습니다.
- 사용자 키 설정을 따릅니다. `↑`/`↓`/`Enter`/`Esc`는 Pi의 `tui.select.*` 바인딩을 사용하고 도움말에 실제 키를 표시합니다.
- 검토 탭에서 확인 키를 누르면 첫 미답변 질문으로 이동하고, 답변한 질문으로 돌아가면 커서가 그 답변 위치로 복원됩니다.

### 보안

- 표시 문자열을 정규화 단계에서 정제합니다. escape·C0·C1 제어 문자와 bidi 제어 문자를 제거하고, 탭·CR을 공백으로 접고, code point 기준으로 길이를 제한합니다. 질문 텍스트는 모델이 작성하고 모델은 파일과 웹 콘텐츠를 읽으므로 터미널 이스케이프 주입 경계입니다.
- 필터 텍스트와 편집기 버퍼처럼 화면에 바로 그려지는 입력도 입력 시점에 정제합니다. `pi-tui`의 붙여넣기 필터는 U+0020 미만 code unit만 제거합니다.
- 입력 크기 상한을 추가했습니다. 질문 20개, 질문당 옵션 50개, `defaultValues` 50개, 표시 문자열 1000 code point, 프롬프트 20줄, 기계값 200 code point, `id` 64 code point입니다.
- 옵션 `value` 중복을 거부합니다.
- 평범한 질문 화면에서 `Esc`는 설정과 무관하게 항상 질문을 취소합니다.

### 변경

- presence를 shared `@pi/presence` typed interaction producer로 전환했습니다. shared protocol lifecycle은 고정된 upstream 문서를 따르며, 이 패키지는 pending projection과 content-free withdrawal만 담당합니다.
- 단일 질문은 `requireReview`가 없으면 검토 탭을 만들지 않습니다.
- 답변 후 다음 질문이 아니라 다음 **미답변** 질문으로 이동합니다.
- 키 바인딩 관리자가 있으면 그 결과를 그대로 따릅니다. 확인 키를 다른 키로 옮기면 `Enter`는 더 이상 선택하지 않습니다.

### 개발

- Biome 2.3.14를 추가하고 `lint`·`lint:fix` 스크립트를 만들었습니다. `ci`는 `lint → check → test` 순서로 실행합니다.

## v0.1.0

- 초기 릴리스. Pi TUI에서 선택형 질문을 하는 `ask_user` 도구를 등록합니다.
- 단일 선택, 다중 선택, 자유 입력과 다중 질문 탭·검토 탭 흐름을 지원합니다.
- 선택적 process-local presence 연동을 포함합니다. 보류 중인 상호작용 상태만 관찰자에게 알리고 questionnaire 내용을 전송하지 않습니다.
- `~/.pi/agent/extensions/ask-user.ts` 단일 파일 구현을 `index.ts` + 평면 `src/` 모듈로 분리하고 단위 테스트와 CI 검증을 추가했습니다.
