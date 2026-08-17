# pi-ask-user

Pi TUI에서 사용자에게 선택형 질문을 하고 구조화된 답변을 에이전트에게 돌려주는 확장 패키지입니다. 단일·다중 선택, 건너뛰기, 자유 입력, 검토를 지원합니다.

저장소: <https://github.com/spi-ca/pi-ask-user>

## 핵심 기능

- **선택·검토** — 단일 선택이 기본이며, `multiSelect: true`이면 Space로 여러 옵션을 토글하고 설정된 확인 키로 확정합니다. `optional` 질문은 건너뛸 수 있고, `requireReview`는 질문 하나도 검토 탭을 거치게 합니다.
- **기본값과 범위** — `defaultValues`로 다중 선택을 미리 고르고, `minSelections`·`maxSelections`로 선택 수를 제한합니다. 단일 선택의 기본값은 답변을 확정하지 않고 커서만 옮깁니다.
- **자유 입력** — 기본으로 활성인 `allowOther`가 옵션 목록 끝에 자유 입력 행을 추가합니다. 다중 선택에서는 선택한 옵션과 입력 텍스트를 함께 제출하며, 입력도 선택 하나로 계산합니다. 최대 선택 수를 넘기는 입력·토글은 거부합니다.
- **긴 목록 탐색** — 화면 높이에 맞는 옵션 창, `↑ N more`/`↓ N more` 표시, `/` 필터, 숫자 바로 선택을 제공합니다.
- **구조화된 결과** — 도구 결과의 `details`에 정규화된 질문, 답변 종류(`single`/`multi`/`custom`/`skipped`), 취소 사유를 담아 반환합니다. 텍스트 결과에는 모델이 사용할 기계값도 표시합니다.
- **안전한 표시** — 모델이 제공한 표시 문자열과 라이브로 보이는 필터·자유 입력에서 제어·bidi 문자를 제거하고 길이를 제한한 뒤 렌더링합니다.
- **선택적 presence** — 질문이 열려 있는 동안 process-local `pi-presence:update:v1`을 발행합니다. 엄격한 V1 `ready` 광고와 consumer-less `ready` 요청으로 상태 replay를 받는 프로토콜 호환 소비자가 같은 프로세스에 있을 때 동작합니다. `presence-remove-v1`은 선택 capability이므로 이를 광고하지 않는 유효 소비자도 update를 받으며, 종료 시에는 동일한 `remove`를 발행합니다. `pi-cmux-presence`와 Herdr가 예시이며, 질문 내용은 전송하지 않습니다.

## 설치

Pi extension을 포함한 제3자 패키지는 **full system access**로 실행됩니다. 설치 전 소스와 Git ref를 검토하세요.

```bash
# 전역 설치
pi install git:github.com/spi-ca/pi-ask-user

# 제거
pi remove git:github.com/spi-ca/pi-ask-user
```

프로젝트에만 설치하려면 프로젝트 루트에서 `-l`을 붙입니다.

```bash
pi install -l git:github.com/spi-ca/pi-ask-user
```

### 로컬 경로 설치·개발

개발 중에는 현재 디렉터리를 로컬 패키지로 설치할 수 있습니다. Pi는 경로를 복사하지 않고 참조합니다.

```bash
bun install
bun run ci
pi install /absolute/path/to/pi-ask-user
```

코드를 바꾼 뒤 실행 중인 Pi에서 `/reload`를 실행합니다. 일회성 점검에는 `pi -e /absolute/path/to/pi-ask-user/index.ts`를 사용할 수 있습니다.

## 빠른 시작

에이전트가 `ask_user` 도구를 호출합니다.

단일 질문:

```json
{
  "questions": [
    {
      "id": "runtime",
      "label": "Runtime",
      "prompt": "어떤 런타임으로 실행할까요?",
      "options": [
        { "value": "bun", "label": "Bun", "description": "권장" },
        { "value": "node", "label": "Node.js" }
      ]
    }
  ]
}
```

기본값·범위가 있는 다중 선택과 선택적 질문:

```json
{
  "questions": [
    {
      "id": "targets",
      "label": "Targets",
      "prompt": "어떤 플랫폼을 지원할까요?",
      "multiSelect": true,
      "defaultValues": ["linux"],
      "minSelections": 1,
      "maxSelections": 2,
      "options": [
        { "value": "macos", "label": "macOS" },
        { "value": "linux", "label": "Linux" }
      ]
    },
    {
      "id": "release",
      "label": "Release",
      "prompt": "릴리스 방식을 고르세요.",
      "optional": true,
      "allowOther": false,
      "options": [
        { "value": "tag", "label": "Git tag" },
        { "value": "manual", "label": "수동 배포" }
      ]
    }
  ]
}
```

`id`는 필수이고 공백을 제거한 뒤 비어 있지 않아야 하며 호출 안에서 고유해야 합니다. `label`을 생략하면 `id`를 표시에 사용합니다. `options`는 최소 하나가 필요합니다. 전체 검증 규칙과 답변 형식은 [`docs/usage.md`](docs/usage.md)를 참고하세요.

## 키 조작

위·아래 이동·확인·취소는 Pi의 `tui.select.up`/`down`/`confirm`/`cancel` 키 바인딩을 따르며 도움말에도 해석된 실제 설정값을 표시합니다. 사용 가능한 `KeybindingsManager`가 있으면 그 바인딩이 권위 있으므로, 바인딩하지 않은 키는 동작하지 않습니다. 예를 들어 확인을 `Enter`에서 다른 키로 바꾸면 `Enter`는 선택하지 않습니다. 관리자가 없거나 오류를 던질 때, 그리고 해당 동작에 바인딩된 키가 하나도 없을 때만 기본 키를 사용합니다. 후자는 모달 프롬프트에서 확인 키가 사라져 답변 자체가 불가능해지는 상황을 막기 위한 것입니다.

| 키 | 동작 |
| --- | --- |
| 설정된 위·아래 이동 키 | 옵션 이동 |
| 설정된 확인 키 | 단일 선택, 다중 선택 확정, 검토 탭 제출 |
| `Space` | 다중 선택 토글 (필터 중에도 동작) |
| `1`–`9` | 표시된 번호의 옵션을 선택하거나 다중 선택을 토글 |
| `/` | 레이블·값·설명을 대소문자 없이 필터링 시작 |
| `a` / `c` | 다중 선택에서 모두 선택 / 모두 지우기 |
| `Tab` / `Shift+Tab`, `←` / `→` | 질문·검토 탭 이동 |
| `Esc` | 편집·필터 중이 아닌 질문 화면에서는 바인딩과 무관하게 항상 설문을 취소 |
| 설정된 취소 키 | 질문을 취소합니다. 자유 입력 중에는 편집만 취소하고, 필터 중에는 필터만 지웁니다 |

자유 입력 편집기는 Pi의 `tui.input.submit` 바인딩으로 제출하므로 도움말도 그 키와 해석된 취소 키를 표시합니다. 선택 목록의 확인 키와는 별개입니다.

## 동작 요약

- 비대화형(`ctx.mode !== "tui"`) 세션에서는 UI를 열지 않고 오류 결과(`cancelReason: "unavailable"`)를 돌려줍니다. 잘못된 파라미터도 UI를 열기 전에 `cancelReason: "invalid"` 오류 결과로 보고합니다.
- 질문 하나는 답변 즉시 제출하지만 `requireReview: true`이면 검토 탭으로 이동합니다. 여러 질문은 답변 뒤 다음 미응답 질문으로 이동하고, 모두 답한 뒤 검토 탭에서 제출합니다.
- 취소된 UI 결과에는 `cancelReason`과 이미 답한 항목이 남습니다. 자유 입력은 앞뒤 공백을 제거해 저장합니다.
- 도구는 `sequential` 실행 모드라 두 질문이 동시에 TUI를 점유하지 않습니다.
- presence 출력은 best-effort입니다. 이벤트 발행 실패나 소비자 부재는 질문 진행에 영향을 주지 않습니다.

## 문서

| 주제 | 문서 |
| --- | --- |
| 도구 호출 형식, 검증 규칙, 답변 형식 | [`docs/usage.md`](docs/usage.md) |
| presence 이벤트 계약과 설정 경계 | [`docs/configuration.md`](docs/configuration.md) |
| 개발 워크플로, 프로젝트 구조, 검증 범위 | [`docs/development.md`](docs/development.md) |
| 변경 이력 | [`CHANGELOG.md`](CHANGELOG.md) |

## 검증

```bash
bun run ci
bun pm pack --dry-run
```

`bun run ci`는 Biome lint, 타입 검사, 테스트를 순서대로 실행합니다. presence 테스트는 외부 구현을 import하지 않는 로컬 고정 V1 consumer fixture로 현재 `pi-cmux-presence`의 ready ID와 capability(`cmux-status`, `cmux-progress`, `cmux-attention`, `presence-remove-v1`), `pi-herdr-presence`의 ready ID와 capability(`presence-remove-v1`, `presence-summary-v1`, `herdr-pane-report-agent-v1`, `herdr-pane-report-metadata-v1`)를 정확히 재현합니다. 각 profile의 consumer-first·producer-first 발견/광고/replay, 엄격한 privacy-safe update/remove, 질문 완료 뒤 remove를 결정론적으로 확인하는 producer 프로토콜 계약 검증만 다루며, 실제 터미널 렌더링과 실행 중인 `pi-cmux-presence`·`pi-herdr-presence`, cmux 서버·socket·CLI·polling 연동은 검증하지 않습니다. 자세한 범위는 [`docs/development.md`](docs/development.md)를 참고하세요.

## 라이선스

MIT. 자세한 내용은 [`LICENSE`](LICENSE)와 [`NOTICE`](NOTICE)를 참고하세요.
