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

유효한 세션이 시작되면 producer는 소비자 유무와 무관하게 아래의 consumer-less 발견 이벤트를 한 번 발행합니다. 이것만은 게이트 대상이 아닙니다.

```json
{ "version": 1, "sessionId": "<현재 세션 ID>" }
```

발견 payload의 own field는 순서와 관계없이 정확히 `version`, `sessionId`뿐입니다. `requestId`, `consumer` 또는 다른 필드는 넣지 않습니다.

반대로 `update`와 `remove`는 아래를 모두 만족할 때만 발행합니다.

1. 현재 세션 ID가 이벤트 계약의 safe text 조건을 만족합니다. 1–96 Unicode code point이고 control·bidi 문자가 없어야 합니다.
2. 같은 세션 ID의 엄격한 `pi-presence:ready:v1` 소비자 광고를 받습니다. 안전한 문자열인 `consumer.id`의 값이나 유효한 `capabilities` 배열의 내용은 update 게이트가 아닙니다.

소비자 광고와 consumer-less 요청은 canonical v1 ready grammar를 따릅니다. 최상위 own data field는 `version`, `sessionId`와 선택 `consumer`만 허용하며, `consumer`가 있으면 own data field는 정확히 `id`, `capabilities`여야 합니다. object prototype은 `Object.prototype` 또는 `null`만 허용합니다. ID와 capability 문자열은 safe text 조건을 만족해야 하며, capability는 최대 16개의 조밀한(dense) 문자열 배열이어야 합니다. capability 중복은 canonical grammar대로 보존합니다. `presence-remove-v1`은 consumer가 remove를 이해한다는 선택 capability일 뿐 producer의 update 또는 remove 발행을 막지 않습니다. extra field, sparse array, accessor, 배열의 숨은·추가 property는 거부합니다. 검증 결과는 원본 payload를 다시 읽지 않는 frozen owned snapshot으로 복사합니다.

소비자 ID를 `pi-cmux-presence`로 제한하지 않습니다. `pi-cmux-presence`, Herdr 및 같은 계약을 지키는 다른 소비자가 호환됩니다. 유효한 consumer 광고가 없으면 `update`와 `remove`는 발행하지 않습니다. 세션 ID 조회가 실패하거나 안전하지 않으면 해당 세션의 presence를 fail-closed로 비활성화하고, 질문 진행에는 영향을 주지 않습니다.

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

- top-level own field는 정확히 `version`, `sessionId`, `generation`, `sequence`, `source`, `state`, `counts`, `attention`입니다.
- `state`는 항상 `waiting`입니다. 이 패키지는 실행·성공·실패 상태를 보고하지 않습니다.
- `counts.active`와 `counts.total`은 현재 열려 있는 설문 도구 호출(활성 request) 수입니다. 설문 안의 개별 질문 수가 아닙니다.
- `attention`은 첫 활성 request에서만 `info`이고, 이후 갱신은 `none`입니다. 알림이 개별 질문마다 반복되지 않게 하기 위한 것입니다.
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

remove의 top-level own field는 정확히 `version`, `sessionId`, `generation`, `sequence`, `source`입니다. 표시·attention 데이터를 담지 않습니다. 활성 설문 도구 호출(request) 수가 0이 되거나 세션이 종료될 때 한 번 발행합니다.

### 발견, 늦은 광고와 세션 교체

소비자는 발견 이벤트를 보고 같은 `sessionId`의 일반 `ready` 광고를 동기 또는 나중에 보낼 수 있습니다. consumer-first 광고도 계속 허용합니다. canonical v1 흐름에서 광고는 passive capability signal이고, 소비자는 이어서 별도의 consumer-less `ready` 요청을 발행해 retained 상태를 받습니다. producer는 자신이 방금 발행한 발견 object를 **동일성(identity)** 으로만 무시하므로, 같은 모양의 다른 요청은 정상적으로 처리합니다. ready 처리 중 재진입을 막아 동기 재발행이 재귀하지 않게 합니다.

- 질문이 이미 열린 뒤 유효한 소비자가 광고하고 consumer-less 요청을 보내면 그 요청마다 새 `sequence`와 `attention: "none"`인 대기 상태를 한 번 replay합니다. 광고만으로는 replay하지 않으며 remove는 활성 request 수가 0일 때만 발행합니다.
- `beginRequest` 중 세션 ID가 바뀌면 기존 상태를 철회하고 새 세션의 발견 이벤트를 먼저 발행합니다. 동기 광고 응답이 처리된 뒤 새 요청의 첫 update를 발행하므로 정상적인 `attention: "info"`를 유지합니다. 이전 세션의 완료 토큰은 무시합니다.
- `session_shutdown`에서 상태를 철회하고 대기 수를 0으로 되돌립니다.

## 개인정보 범위

presence payload에는 고정 source label(`Pi needs your input`), 상태, 개수, 세션 ID, 순서 필드만 담습니다. 질문 `prompt`, 옵션 `label`·`value`·`description`, skip 상태, 필터 텍스트, 사용자 자유 입력, 선택 항목과 답변 내용은 어떤 형태로도 전송하지 않습니다. 자동 검증은 실제 설문 입력의 ID·label·prompt·option value·label·description canary 문자열이 각 직렬화 payload에 없는지와, 발행된 `sessionId`가 기대한 세션 ID와 정확히 같은지를 확인합니다.

## 실패 처리

- `pi.events.emit` 실패는 삼켜집니다. presence 출력만 유실되고 질문은 계속 진행합니다.
- 잘못된 형식의 `ready` payload는 무시합니다. 안전하지 않거나 큰 ID·capability, extra field, sparse array, 허용하지 않는 object prototype, accessor, `version !== 1`, 다른 세션 ID가 모두 여기에 해당합니다.
- 소비자가 없으면 발견 이벤트만 발행하며 `update`와 `remove`는 발행하지 않으므로 단독 설치에서도 표시 상태 부작용이 없습니다.

## 관련 문서

- [`usage.md`](usage.md) — 도구 호출 형식과 검증 규칙
- [`development.md`](development.md) — 검증 범위와 변경 불변 조건
