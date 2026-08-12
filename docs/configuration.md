# 설정과 presence 계약

이 패키지는 환경 변수, 설정 파일, 슬래시 명령을 추가하지 않습니다. 조정 가능한 것은 도구 호출 인수뿐이며, 유일한 외부 인터페이스는 선택적 process-local presence 이벤트입니다.

## 설정 표면

| 항목 | 지원 | 비고 |
| --- | --- | --- |
| 환경 변수 | 없음 | presence 활성 여부도 환경 변수로 제어하지 않습니다 |
| 설정 파일 | 없음 | `pi-ask-user.json` 같은 파일을 읽지 않습니다 |
| 슬래시 명령 | 없음 | 도구 하나만 등록합니다 |
| 도구 인수 | 있음 | [`usage.md`](usage.md)의 질문·옵션 필드 |

질문 표시 방식은 호출마다 `multiSelect`, `allowOther`, `optional`, `requireReview`, 선택 범위와 자유 입력 관련 필드로 결정합니다. 전역 기본값을 바꾸는 설정은 없습니다.

## presence 이벤트

질문이 열려 있는 동안 같은 Pi 프로세스의 event bus에 `pi-presence:update:v1`을 발행하고, 모두 닫히면 `pi-presence:remove:v1`으로 철회합니다. 이는 관찰용 출력이며 lifecycle 권한이 아닙니다.

### 게이트 조건

presence 출력은 아래를 모두 만족할 때만 발생합니다.

1. 현재 세션 ID가 이벤트 계약의 safe text 조건을 만족합니다. 1–96 Unicode code point이고 control·bidi 문자가 없어야 합니다.
2. 같은 세션 ID로 `pi-presence:ready:v1` 광고를 받았고, 그 `consumer.id`가 정확히 `pi-cmux-presence`이며 `capabilities`에 `presence-remove-v1`이 포함됩니다.

조건을 만족하지 못하면 아무것도 발행하지 않습니다. 세션 ID 조회가 실패하거나 안전하지 않으면 해당 세션의 presence를 fail-closed로 비활성화하고, 질문 진행에는 영향을 주지 않습니다.

### update payload

```json
{
  "version": 1,
  "sessionId": "<현재 세션 ID>",
  "generation": 1770000000000,
  "sequence": 1,
  "source": { "id": "ask-user", "label": "Pi needs your input", "kind": "interaction" },
  "state": "waiting",
  "counts": { "active": 1, "completed": 0, "failed": 0, "total": 1 },
  "attention": "info"
}
```

- `state`는 항상 `waiting`입니다. 이 패키지는 실행·성공·실패 상태를 보고하지 않습니다.
- `counts.active`와 `counts.total`은 현재 열려 있는 질문 수입니다.
- `attention`은 첫 질문에서만 `info`이고, 이후 갱신은 `none`입니다. 알림이 질문 하나마다 반복되지 않게 하기 위한 것입니다.
- `generation`은 세션마다 증가하며 같은 세션 안에서는 고정입니다. `sequence`는 발행마다 1씩 증가합니다.

### remove payload

```json
{
  "version": 1,
  "sessionId": "<현재 세션 ID>",
  "generation": 1770000000000,
  "sequence": 2,
  "source": { "id": "ask-user" }
}
```

remove는 표시·attention 데이터를 담지 않습니다. 열린 질문 수가 0이 되거나 세션이 종료될 때 한 번 발행합니다.

### 늦은 광고와 세션 교체

- 질문이 이미 열린 뒤 광고가 도착하면 그 시점에 `attention: "none"`으로 대기 상태를 발행합니다.
- 요청 중 세션 ID가 바뀌면 기존 상태를 철회하고 새 세션으로 초기화합니다. 이전 세션의 완료 토큰은 무시합니다.
- `session_shutdown`에서 상태를 철회하고 대기 수를 0으로 되돌립니다.

## 개인정보 범위

presence payload에는 고정 source label(`Pi needs your input`), 상태, 개수, 세션 ID, 순서 필드만 담습니다. 질문 `prompt`, 옵션 `label`·`value`·`description`, skip 상태, 필터 텍스트, 사용자 자유 입력, 선택 항목과 답변 내용은 어떤 형태로도 전송하지 않습니다. 자동 검증의 canary 테스트는 고정 source label만 나타나는지 확인합니다.

## 실패 처리

- `pi.events.emit` 실패는 삼켜집니다. presence 출력만 유실되고 질문은 계속 진행합니다.
- 잘못된 형식의 `ready` payload는 무시합니다. 다른 소비자 ID, remove 기능 미광고, `version !== 1`, 다른 세션 ID가 모두 여기에 해당합니다.
- 소비자가 없으면 아무 이벤트도 발행하지 않으므로 단독 설치에서도 부작용이 없습니다.

## 관련 문서

- [`usage.md`](usage.md) — 도구 호출 형식과 검증 규칙
- [`development.md`](development.md) — 검증 범위와 변경 불변 조건
