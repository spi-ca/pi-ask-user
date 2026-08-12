# 변경 이력

## v0.1.0

- 초기 릴리스. Pi TUI에서 선택형 질문을 하는 `ask_user` 도구를 등록합니다.
- 단일 선택, 다중 선택, 자유 입력과 다중 질문 탭·검토 탭 흐름을 지원합니다.
- 선택적 process-local presence producer(`pi-presence:update:v1`/`remove:v1`)를 포함합니다. remove 기능을 광고한 `pi-cmux-presence` 소비자가 같은 프로세스에 있을 때만 동작합니다.
- `~/.pi/agent/extensions/ask-user.ts` 단일 파일 구현을 `index.ts` + 평면 `src/` 모듈로 분리하고 단위 테스트와 CI 검증을 추가했습니다.
