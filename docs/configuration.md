# 설정과 presence 계약

이 패키지는 환경 변수, 설정 파일, 슬래시 명령을 추가하지 않습니다. 조정 가능한 것은 도구 호출 인수뿐이며, 선택적 process-local presence는 관찰용 출력입니다.

## 설정 표면

| 항목 | 지원 | 비고 |
| --- | --- | --- |
| 환경 변수 | 없음 | presence 활성 여부도 환경 변수로 제어하지 않습니다 |
| 설정 파일 | 없음 | `pi-ask-user.json` 같은 파일을 읽지 않습니다 |
| 슬래시 명령 | 없음 | 도구 하나만 등록합니다 |
| 도구 인수 | 있음 | [`usage.md`](usage.md)의 질문·옵션 필드 |

질문 표시 방식은 호출마다 `multiSelect`, `allowOther`, `optional`, `requireReview`, 선택 범위와 자유 입력 관련 필드로 결정합니다. 전역 기본값을 바꾸는 설정은 없습니다.

## presence 연동

질문이 열려 있는 동안 shared [`@pi/presence`](https://github.com/spi-ca/pi-presence/tree/v2-20260818-2)의 `interaction` producer로 `ask_user` pending 상태를 발행하고, 마지막 요청이 끝나면 철회합니다. 이는 questionnaire의 lifecycle 권한이 아니며, 소비자 부재·전달 오류·producer 오류는 질문의 완료·취소·답변 결과에 영향을 주지 않습니다.

이 패키지는 도구가 실제로 대기 중인지만 projection합니다.

- 검증을 통과하고 TUI를 열기 직전에 요청을 추가합니다. 첫 요청은 새 lifecycle을 열고, 같은 세션의 동시 요청은 pending 수만 갱신합니다.
- 완료, 사용자 취소, abort, 동기·비동기 UI 오류 모두 `finally`에서 요청을 끝냅니다. 세션 종료나 로컬 세션 교체도 활성 projection을 정리하며, 이전 요청 token의 완료는 무시합니다.
- source가 일시적으로 점유되어도 도구 요청이나 token accounting을 초기화하지 않고, 이후 요청에서 재활성화를 시도합니다.

공유 channel 이름, 이벤트 schema와 parser, ordinal 상한, retained replay, consumer epoch, generation/sequence fence, registry와 producer/consumer API의 규범은 이 저장소가 복제하지 않습니다. 다음 immutable 문서를 단일 출처로 사용합니다.

- [protocol](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/protocol.md) — 이벤트 계약과 검증·전달 규칙
- [lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/lifecycle.md) — producer/consumer lifecycle과 replay·fence 규칙
- [API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md) — handle 생성·활성화·발행·철회 API

## 개인정보 범위

이 패키지는 `interaction.kind`와 pending 수만 shared producer에 전달합니다. 질문 ID·prompt·옵션의 label/value/description, 답변, 자유 입력, 취소 사유, task·path·error·credential·run ID·session ID는 전달하지 않습니다. shared consumer delivery에만 해당하는 메타데이터는 이 패키지의 producer input, 표시, 로그에 넣지 않습니다.

## 실패 처리와 경계

- shared producer 생성·활성화·발행·철회·비활성화와 event-bus emit은 모두 best-effort입니다. 오류는 삼키며 questionnaire 동작을 지연하거나 실패시키지 않습니다.
- 이 패키지는 polling, socket, CLI, process 실행, persistent connection, background daemon을 만들지 않습니다.
- shared protocol parser나 compatibility fallback을 구현하지 않습니다.

의존성은 [`github:spi-ca/pi-presence#v2-20260818-2`](https://github.com/spi-ca/pi-presence/tree/v2-20260818-2)에 정확히 고정합니다. version range나 로컬 path dependency로 바꾸지 않아 연동 패키지의 계약이 갈라지지 않게 합니다.

## 관련 문서

- [`usage.md`](usage.md) — 도구 호출 형식과 검증 규칙
- [`development.md`](development.md) — 검증 범위와 변경 불변 조건
