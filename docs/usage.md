# 사용법

`ask_user` 도구의 호출 형식, 입력 검증 규칙, 반환 형식을 설명합니다. 설치와 키 조작은 저장소 루트의 [`README.md`](../README.md)를 참고하세요.

## 호출 형식

도구는 최상위 `questions` 배열 하나만 받습니다. 배열은 비어 있을 수 없고 최대 20개 질문을 담을 수 있습니다.

```json
{
  "questions": [
    {
      "id": "runtime",
      "label": "Runtime",
      "prompt": "어떤 런타임으로 실행할까요?",
      "multiSelect": false,
      "allowOther": true,
      "optional": false,
      "requireReview": false,
      "options": [
        { "value": "bun", "label": "Bun", "description": "권장" },
        { "value": "node", "label": "Node.js" }
      ]
    }
  ]
}
```

### 질문 필드

| 필드 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `id` | 예 | — | 답변을 식별하는 키. 공백 제거 후 비어 있지 않아야 하고 호출 안에서 고유해야 합니다 |
| `prompt` | 예 | — | 질문 본문. 줄바꿈은 유지하고 폭에 맞춰 렌더링합니다 |
| `options` | 예 | — | 선택 항목 배열. 최소 1개, 최대 50개 |
| `label` | 아니오 | `id` | 탭과 결과 요약에 쓰는 짧은 이름. 빈 문자열이면 `id`를 사용 |
| `multiSelect` | 아니오 | `false` | `true`면 Space 또는 숫자로 여러 옵션을 토글하고 설정된 확인 키로 확정 |
| `allowOther` | 아니오 | `true` | 자유 입력 행 표시 여부. 끄려면 명시적으로 `false` |
| `optional` | 아니오 | `false` | `true`면 `Skip this question.` 행을 추가합니다. 선택하면 `skipped` 답변으로 완료됩니다 |
| `requireReview` | 아니오 | `false` | 질문 하나만 있는 호출도 답변 직후 제출하지 않고 검토 탭으로 보냅니다 |
| `defaultValues` | 아니오 | `[]` | 미리 선택하거나 커서를 옮길 옵션 `value`의 문자열 배열. 최대 50개 |
| `minSelections` | 아니오 | `1` | 다중 선택에서 필요한 최소 선택 수. 자유 입력 텍스트도 하나로 계산합니다 |
| `maxSelections` | 아니오 | 제한 없음 | 다중 선택에서 허용하는 최대 선택 수. 자유 입력 텍스트도 하나로 계산합니다 |
| `otherLabel` | 아니오 | `Type something.` | 자유 입력 행의 표시 레이블 |
| `otherPlaceholder` | 아니오 | 없음 | 자유 입력 편집기 위에 표시할 힌트 |
| `otherMaxLength` | 아니오 | `500` | 자유 입력의 최대 code point 수. 최대 `2000` |

`defaultValues`의 모든 값은 해당 질문의 옵션 `value`와 일치해야 합니다. 다중 선택에서는 해당 옵션을 미리 토글하고 첫 기본값으로 커서를 옮깁니다. 단일 선택에는 하나만 둘 수 있으며, 이는 답변을 확정하지 않고 커서만 그 옵션으로 옮깁니다. `maxSelections`를 지정했으면 기본값 수가 이를 넘을 수 없습니다. 다중 선택에서 자유 입력은 선택 하나로 계산합니다. 자유 입력만으로 최대 선택 수에 도달했다면 옵션 토글은 거부되고, 자유 입력이 최대 선택 수를 넘기게 되면 텍스트를 저장하거나 답변을 기록하지 않고 최대 선택 수 오류를 표시합니다.

질문을 하나만 호출할 때는 기본적으로 답변 즉시 결과를 반환합니다. `requireReview: true`이면 검토 탭에서 확인 키를 한 번 더 눌러야 합니다. 여러 질문은 답변한 뒤 순서상 다음 질문이 아니라 **다음 미응답 질문**으로 이동하고, 모두 답한 뒤 검토 탭을 표시합니다.

### 옵션 필드

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `value` | 예 | 답변에 담기는 기계용 값. 최대 200 code point이며 질문 안에서 고유해야 합니다 |
| `label` | 예 | 목록에 표시하는 이름 |
| `description` | 아니오 | 라벨 아래 들여쓰기로 표시하는 보조 설명. `/` 필터 대상입니다 |

## 입력 검증

정규화는 UI를 열기 전에 수행하며, 실패하면 오류 문자열을 `cancelled: true`, `cancelReason: "invalid"` 결과로 반환합니다. 예외를 던지지 않습니다.

| 조건 | 반환 메시지 |
| --- | --- |
| `questions`가 없거나 배열이 아니거나 비어 있음 | `Error: No questions provided` |
| 질문이 20개 초과 | `Error: More than 20 questions provided` |
| 질문이 객체가 아니거나 `id`·`prompt`가 문자열이 아님 | `Error: Question N is invalid` |
| `id`가 공백만이거나 64 code point 초과이거나 앞선 질문과 중복 | `Error: Question N is invalid` |
| `options`가 배열이 아니거나 비어 있음 | `Error: Question N has no options` |
| 옵션이 50개 초과 | `Error: Question N has more than 50 options` |
| 옵션이 객체가 아니거나 `value`·`label`이 문자열이 아님 | `Error: Option M for question N is invalid` |
| 옵션 `description`이 문자열이 아님 | `Error: Option M for question N is invalid` |
| 옵션 `value`가 200 code point 초과 | `Error: Option M for question N has a value longer than 200 characters` |
| 한 질문 안에서 정제 뒤 옵션 `value`가 중복 | `Error: Option M for question N repeats value "v"` |
| `minSelections`가 양의 정수가 아니거나 옵션 수 초과 | `Error: Question N has an invalid minSelections` |
| `maxSelections`가 양의 정수가 아니거나 옵션 수 초과 | `Error: Question N has an invalid maxSelections` |
| `maxSelections`가 `minSelections`보다 작음 | `Error: Question N has maxSelections below minSelections` |
| `otherMaxLength`가 1–2000 양의 정수가 아님 | `Error: Question N has an invalid otherMaxLength` |
| `defaultValues`가 50개 초과 | `Error: Question N has more than 50 defaultValues` |
| `defaultValues`가 배열이 아니거나 문자열이 아닌 항목을 포함 | `Error: Question N has invalid defaultValues` |
| `defaultValues` 항목이 옵션 값과 일치하지 않음 | `Error: Question N has a defaultValues entry that matches no option` |
| 단일 선택에 기본값을 둘 이상 제공 | `Error: Question N is single-select and cannot have multiple defaultValues` |
| 기본값 수가 `maxSelections`를 초과 | `Error: Question N has more defaultValues than maxSelections allows` |

`N`과 `M`은 1부터 시작하는 위치입니다. `id`는 비교와 저장 모두 공백을 제거한 값을 사용하므로 `"lang"`과 `" lang "`은 중복입니다. 반대로 `prompt`, `label`, 옵션 `value`·`label`은 자동으로 `trim`하지 않습니다. 자유 입력 답변만 저장 시점에 `trim`합니다.

### 표시 문자열 안전 처리

질문 텍스트는 파일·명령 출력·웹 내용을 읽는 모델이 제공할 수 있으므로 표시 경계에서 정제합니다. escape, C0/C1 제어 문자와 bidi 제어 문자를 제거하고, 탭과 carriage return은 공백으로 바꿉니다. 줄바꿈은 `prompt`에서만 유지합니다. 라이브로 렌더링하는 필터 텍스트와 자유 입력 편집기 버퍼도 입력 중에 같은 제어·bidi 문자를 제거합니다. 따라서 붙여넣은 텍스트도 화면에 표시되기 전에 정제되며, 편집기 버퍼는 `otherMaxLength`를 넘지 않습니다.

| 대상 | 최대 길이 |
| --- | --- |
| `prompt`, 옵션 `label`·`description` | 1000 code point. `prompt`는 연속 빈 줄을 한 빈 줄로 줄이고, 원문 줄은 최대 20개만 유지한 뒤 초과분을 별도 `…` 줄로 생략 |
| 질문 `label`, `otherLabel` | 80 code point |
| `otherPlaceholder` | 120 code point |
| 필터 텍스트 | 64 code point |
| 접힌 도구 호출 줄의 레이블 | 레이블당 60 code point, 처음 8개만 표시한 뒤 남으면 `, …` |
| 정규화된 `details`가 없는 결과 텍스트 | 500 code point. host 측 스키마 거부처럼 원문일 수 있는 결과도 정제 후 표시 |

긴 표시 문자열은 마지막 글자를 ellipsis(`…`)로 바꾸어 자릅니다. 기계값은 자르지 않고 200 code point를 넘으면 검증 오류가 납니다.

비대화형 세션에서는 검증 전에 `Error: UI not available (running in non-interactive mode)`를 반환하며 결과의 `cancelReason`은 `"unavailable"`입니다.

## 반환 형식

완료된 도구 결과의 텍스트는 답변한 질문마다 `라벨: 답변` 한 줄입니다. 옵션의 결합 기계값이 표시 레이블과 다르면 대괄호에 함께 넣어 모델이 값을 사용할 수 있게 합니다. 자유 입력 답변에는 대괄호를 추가하지 않습니다.

```text
Runtime: Bun [bun]
Targets: macOS, Linux [macos, linux]
Language: Klingon
```

`details`에는 정규화된 질문과 답변이 함께 담깁니다.

```json
{
  "questions": [
    {
      "id": "runtime",
      "label": "Runtime",
      "prompt": "어떤 런타임으로 실행할까요?",
      "options": [{ "value": "bun", "label": "Bun", "description": "권장" }],
      "multiSelect": false,
      "allowOther": true,
      "optional": false,
      "requireReview": false,
      "defaultValues": [],
      "minSelections": 1,
      "otherLabel": "Type something.",
      "otherMaxLength": 500
    }
  ],
  "answers": [{ "id": "runtime", "kind": "single", "value": "bun", "label": "Bun", "index": 1 }],
  "cancelled": false
}
```

`maxSelections`와 `otherPlaceholder`는 설정하지 않으면 정규화된 질문에서 생략됩니다.

### 답변 종류

| `kind` | 필드 | 설명 |
| --- | --- | --- |
| `single` | `value`, `label`, `index` | 옵션 하나 선택. `index`는 1부터 시작하는 원래 옵션 순번 |
| `multi` | `selections[]`, 선택적 `custom` | 선택 항목은 각각 `value`·`label`·`index`를 가지며 원래 옵션 순서대로 정렬됩니다. `custom`은 함께 입력한 자유 텍스트입니다 |
| `custom` | `value`, `label` | 단일 선택 질문의 자유 입력. 두 필드 모두 정제·`trim`한 입력값 |
| `skipped` | 없음 | 선택적 질문을 건너뜀. 객체에는 `id`와 `kind`만 있습니다 |

`answers`는 질문 정의 순서를 따르며, 답하지 않은 질문은 빠집니다. 따라서 취소된 결과에는 그때까지 답한 항목만 남습니다.

### 취소

`cancelled: true` 결과에는 `cancelReason`이 있으며 `"user"`, `"aborted"`, `"unavailable"`, `"invalid"` 중 하나입니다. UI에서 사용자가 Esc로 취소하면 텍스트는 다음과 같습니다.

```text
User cancelled the questionnaire (the user cancelled)
```

도구 호출 abort는 `(the tool call was aborted)`을 사용합니다. UI 취소 시 이미 답한 항목이 있으면 뒤에 다음 형식으로 이어 붙입니다.

```text
Answered so far:
Runtime: Bun [bun]
```

비대화형·잘못된 입력은 각각 앞서 설명한 오류 텍스트를 즉시 반환하지만, 구조화된 결과에는 각각 `"unavailable"`·`"invalid"` 사유를 기록합니다. 접힌 결과 줄은 사용자 취소면 `Cancelled`, 그 밖의 사유면 `Cancelled (aborted)`처럼 표시합니다.

## 표시 동작

- 도구 호출 줄에는 질문 개수와 레이블 목록을 표시합니다. 레이블이 없으면 `id`, 그다음 `prompt`, 마지막으로 `Question`을 사용하며 표시 전 정제·레이블당 60 code point 제한을 적용합니다. 처음 8개만 표시하고 남은 질문이 있으면 `, …`를 덧붙입니다.
- 옵션은 터미널 높이에서 계산한 3–10행 창으로 표시합니다. 숨긴 행이 있으면 `↑ N more` 또는 `↓ N more`를 표시합니다.
- `/`는 레이블·값·설명을 대소문자 없이 필터링합니다. 필터 텍스트는 입력 중 제어·bidi 문자를 버리고 64 code point로 제한합니다. 필터 중 확인·위아래 이동과 다중 선택 Space는 계속 동작하고, 취소 키는 질문을 취소하지 않고 필터를 지웁니다.
- 다중 선택은 `a`로 실제 옵션을 모두 선택하고 `c`로 선택·자유 입력을 모두 지웁니다. 범위가 있으면 `N selected • Choose 2–3` 같은 카운터를 표시합니다.
- 검토 탭은 답한 질문만 요약합니다. 미응답 질문이 있으면 확인 키가 첫 미응답 질문으로 이동하며 제출하지 않습니다. 답한 질문으로 돌아가면 해당 답변 위치에 커서를 복원하고, 자유 입력 답변은 자유 입력 행에, 건너뛴 답변은 건너뛰기 행에 커서를 둡니다.
- 결과 줄에는 답변마다 `✓ 라벨: 답변`을 표시하고 단일 자유 입력은 `(wrote)`로 구분합니다. 건너뛴 답변은 `– 라벨: (skipped)`로 표시합니다.

## 관련 문서

- [`configuration.md`](configuration.md) — presence 이벤트 계약과 설정 경계
- [`development.md`](development.md) — 개발 워크플로와 프로젝트 구조
