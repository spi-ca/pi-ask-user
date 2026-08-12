# pi-ask-user

Pi TUI에서 사용자에게 선택형 질문을 하고 구조화된 답변을 에이전트에게 돌려주는 확장 패키지입니다. 단일 질문과 여러 질문을 모두 지원하며, 다중 선택과 자유 입력을 함께 쓸 수 있습니다.

저장소: <https://github.com/spi-ca/pi-ask-user>

## 핵심 기능

- **선택형 질문** — 옵션 목록에서 하나를 고르는 단일 선택이 기본입니다. `multiSelect: true`이면 Space로 여러 옵션을 토글하고 Enter로 확정합니다.
- **자유 입력** — 기본으로 활성인 `allowOther`가 옵션 목록 끝에 "Type something." 항목을 추가합니다. 선택하면 인라인 편집기가 열리고, 공백만 입력하면 거부합니다.
- **다중 질문 탭** — 질문이 둘 이상이면 상단 탭으로 질문 사이를 이동하고, 마지막 검토 탭에서 답변을 확인한 뒤 한 번에 제출합니다.
- **구조화된 결과** — 도구 결과의 `details`에 정규화된 질문 목록과 답변 종류(`single`/`multi`/`custom`)를 담아 반환합니다.
- **취소 처리** — Esc와 도구 호출 abort가 모두 취소로 수렴하며, 취소는 정확히 한 번만 확정됩니다.
- **선택적 presence** — 질문이 열려 있는 동안 process-local `pi-presence:update:v1`을 발행합니다. `pi-cmux-presence`처럼 remove 기능을 광고한 소비자가 같은 프로세스에 있을 때만 동작하며, 질문 내용은 전송하지 않습니다.

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

다중 선택과 여러 질문:

```json
{
  "questions": [
    {
      "id": "targets",
      "label": "Targets",
      "prompt": "어떤 플랫폼을 지원할까요?",
      "multiSelect": true,
      "options": [
        { "value": "macos", "label": "macOS" },
        { "value": "linux", "label": "Linux" }
      ]
    },
    {
      "id": "release",
      "label": "Release",
      "prompt": "릴리스 방식을 고르세요.",
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

| 키 | 동작 |
| --- | --- |
| `↑` / `↓` | 옵션 이동 |
| `Enter` | 선택, 다중 선택 확정, 검토 탭에서 제출 |
| `Space` | 다중 선택 토글 (자유 입력 항목에는 적용되지 않음) |
| `Tab` / `Shift+Tab`, `←` / `→` | 질문 탭 이동 (질문이 둘 이상일 때) |
| `Esc` | 질문 취소. 자유 입력 중에는 편집만 취소 |

## 동작 요약

- 비대화형(`ctx.mode !== "tui"`) 세션에서는 UI를 열지 않고 오류 결과를 돌려줍니다.
- 잘못된 파라미터는 UI를 열기 전에 거부하고, 오류 메시지는 취소된 질문 결과로 보고합니다.
- 질문이 하나면 답변 즉시 제출됩니다. 여러 개면 마지막 질문을 답한 뒤 검토 탭으로 이동하고, 미응답 질문이 있으면 제출을 거부합니다.
- 자유 입력 답변은 앞뒤 공백을 제거해 저장하고, 표시할 때 `(wrote)`로 구분합니다.
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

`bun run ci`는 타입 검사와 테스트를 순서대로 실행합니다. 테스트는 실제 `pi-tui` 편집기와 fake TUI/theme으로 키 입력부터 렌더 출력까지 확인하지만, 실제 터미널 렌더링과 실행 중인 `pi-cmux-presence` 연동은 검증하지 않습니다.

## 라이선스

MIT. 자세한 내용은 [`LICENSE`](LICENSE)와 [`NOTICE`](NOTICE)를 참고하세요.
