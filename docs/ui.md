# 다른 확장에서 설문 UI 사용

`pi-ask-user/ui`는 확장 등록 없이 설문 컴포넌트와 입력 정규화 함수를 가져오는 공개 경로입니다. 패키지 루트 `pi-ask-user`와 `index.ts`는 기존 `ask_user` 확장 진입점 그대로입니다. `src/*` 직접 import는 내부 구현 경로이며 공개 호환성 계약에 포함되지 않습니다. 컴포넌트는 Pi의 TUI 환경에서만 열어야 합니다.

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createQuestionnaireComponent,
  normalizeQuestions,
  type QuestionnaireResult,
} from "pi-ask-user/ui";

// hostCanShowPrompt는 호출 확장이 실제 화면 상태를 측정해서 제공하는 함수입니다.
async function ask(ctx: ExtensionContext, hostCanShowPrompt: () => boolean): Promise<QuestionnaireResult> {
  if (ctx.mode !== "tui") throw new Error("TUI에서만 설문을 열 수 있습니다");
  const questions = normalizeQuestions({
    questions: [{
      id: "proceed",
      prompt: "진행할까요?",
      allowOther: false,
      defaultValues: ["no"],
      options: [
        { value: "yes", label: "예" },
        { value: "no", label: "아니요" },
      ],
    }],
  });
  if (typeof questions === "string") throw new Error(questions);

  const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, keybindings, done) =>
    createQuestionnaireComponent({
      questions,
      tui,
      theme,
      keybindings,
      done,
      canSubmit: (result) => {
        const answer = result.answers.find((item) => item.id === "proceed");
        if (answer?.kind === "single" && answer.value === "no") return true;
        return hostCanShowPrompt();
      },
    }),
  );
  if (result.cancelled) {
    // result.cancelReason: "user" | "aborted" | "unavailable" | "invalid" (취소 시에만 존재)
  } else {
    const answer = result.answers.find((item) => item.id === "proceed");
    // 단일 선택 answer.kind === "single"이면 answer.value가 외부 식별자("yes"/"no")입니다.
  }
  return result;
}
```

`normalizeQuestions({ questions: [...] })`는 정규화된 `Question[]` 또는 오류 문자열을 돌려줍니다. `createQuestionnaireComponent`는 정규화된 질문을 받아 `QuestionnaireComponent`를 반환합니다. `done(result)`는 한 번만 호출됩니다. `result`는 `questions`, 질문 순서의 `answers`, `cancelled`와 취소 시 `cancelReason`을 포함합니다. 단일 선택의 `value`는 옵션의 외부 식별자이며 표시 순서인 `index`(1부터 시작)나 `label`과 다릅니다. 다중 선택은 `selections[].value`, 자유 입력은 `custom` 또는 `value`, 건너뛰기는 `kind: "skipped"`를 사용합니다. 취소해도 이미 기록된 답변은 남습니다.

`canSubmit(result)`는 **취소가 아닌 제출 직전** 동기적으로 실행됩니다. `false`면 확정·`done`을 실행하지 않고 현재 답변과 UI를 유지하므로 사용자가 화면을 조정하거나 답을 바꾼 뒤 다시 시도할 수 있습니다. 취소는 언제나 가능하며 이 함수를 호출하지 않습니다. 함수를 생략하면 이전과 같이 바로 제출합니다. 예제의 `hostCanShowPrompt`처럼 호스트 가시성은 호출 측에서 측정하고 판단하세요. 설문 UI는 호스트별 정책을 내장하지 않습니다. `defaultValues: ["no"]`는 커서를 아니요로 옮길 뿐 답변을 자동 확정하지 않습니다. 단일 질문은 숫자 선택이나 Enter로 즉시 제출을 시도하므로 확인 전에 검사할 조건은 `canSubmit`에 두세요.
