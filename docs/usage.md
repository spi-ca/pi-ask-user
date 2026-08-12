# 사용법

`ask_user` 도구의 호출 형식, 입력 검증 규칙, 반환 형식을 설명합니다. 설치와 키 조작은 저장소 루트의 [`README.md`](../README.md)를 참고하세요.

## 호출 형식

도구는 최상위 `questions` 배열 하나만 받습니다. 배열은 비어 있을 수 없습니다.

```json
{
  "questions": [
    {
      "id": "runtime",
      "label": "Runtime",
      "prompt": "어떤 런타임으로 실행할까요?",
      "multiSelect": false,
      "allowOther": true,
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
| `prompt` | 예 | — | 질문 본문. 폭에 맞춰 줄바꿈됩니다 |
| `options` | 예 | — | 선택 항목 배열. 최소 하나 필요 |
| `label` | 아니오 | `id` | 탭과 결과 요약에 쓰는 짧은 이름. 빈 문자열이면 `id`를 사용 |
| `multiSelect` | 아니오 | `false` | `true`면 Space로 여러 옵션을 토글하고 Enter로 확정 |
| `allowOther` | 아니오 | `true` | 자유 입력 항목 표시 여부. 끄려면 명시적으로 `false` |

### 옵션 필드

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `value` | 예 | 답변에 담기는 기계용 값 |
| `label` | 예 | 목록에 표시하는 이름 |
| `description` | 아니오 | 라벨 아래 들여쓰기로 표시하는 보조 설명 |

## 입력 검증

정규화는 UI를 열기 전에 수행하며, 실패하면 오류 문자열을 취소된 질문 결과로 반환합니다. 예외를 던지지 않습니다.

| 조건 | 반환 메시지 |
| --- | --- |
| `questions`가 없거나 배열이 아니거나 비어 있음 | `Error: No questions provided` |
| 질문이 객체가 아니거나 `id`·`prompt`가 문자열이 아님 | `Error: Question N is invalid` |
| `id`가 공백만이거나 앞선 질문과 중복 | `Error: Question N is invalid` |
| `options`가 배열이 아니거나 비어 있음 | `Error: Question N has no options` |
| 옵션이 객체가 아니거나 `value`·`label`이 문자열이 아님 | `Error: Option M for question N is invalid` |
| 옵션 `description`이 문자열이 아님 | `Error: Option M for question N is invalid` |

`N`과 `M`은 1부터 시작하는 위치입니다. `id`는 비교와 저장 모두 공백을 제거한 값을 사용하므로 `"lang"`과 `" lang "`은 중복입니다. 반대로 `prompt`, `label`, 옵션 `value`·`label`은 자동으로 `trim`하지 않습니다. 자유 입력 답변만 저장 시점에 `trim`합니다.

비대화형 세션에서는 검증 전에 `Error: UI not available (running in non-interactive mode)`를 반환합니다.

## 반환 형식

도구 결과의 텍스트는 답변한 질문마다 `라벨: 답변` 한 줄입니다.

```text
Runtime: Bun
Targets: macOS, Linux
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
      "allowOther": true
    }
  ],
  "answers": [{ "id": "runtime", "kind": "single", "value": "bun", "label": "Bun", "index": 1 }],
  "cancelled": false
}
```

### 답변 종류

| `kind` | 필드 | 설명 |
| --- | --- | --- |
| `single` | `value`, `label`, `index` | 옵션 하나 선택. `index`는 1부터 시작하는 표시 순번 |
| `multi` | `selections[]` | 각 항목이 `value`·`label`·`index`. 옵션 순서대로 정렬 |
| `custom` | `value`, `label` | 자유 입력. 두 필드 모두 `trim`한 입력값 |

`answers`는 질문 정의 순서를 따르며, 답하지 않은 질문은 빠집니다. 따라서 취소된 결과에는 그때까지 답한 항목만 남습니다.

### 취소

`cancelled: true`인 결과의 텍스트는 `User cancelled the questionnaire`입니다. 취소는 Esc, 검토 탭 Esc, 도구 호출 abort에서 발생하며 정확히 한 번만 확정됩니다. abort가 UI가 열리기 전에 도착해도 취소로 처리합니다.

## 표시 동작

- 도구 호출 줄에는 질문 개수와 라벨 목록을 표시합니다. 라벨이 없으면 `id`, 그다음 `prompt`, 마지막으로 `Question`을 사용합니다.
- 결과 줄에는 답변마다 `✓ 라벨: 답변`을 표시하고 자유 입력은 `(wrote)`를 앞에 붙입니다. 취소는 `Cancelled` 한 줄입니다.
- 검토 탭은 답한 질문만 요약하고, 남은 질문이 있으면 `Unanswered: ...`로 표시하며 Enter 제출을 막습니다.

## 관련 문서

- [`configuration.md`](configuration.md) — presence 이벤트 계약과 설정 경계
- [`development.md`](development.md) — 개발 워크플로와 프로젝트 구조
