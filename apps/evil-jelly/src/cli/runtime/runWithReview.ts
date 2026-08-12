import { type ModelAdapter, runWith } from "@rejelly/core";
import { enableReview, type ReviewOptions } from "@rejelly/core/debugger";
import { resolveReviewOptions } from "../../shared/configuration/env";

type RunWithOptions = NonNullable<Parameters<typeof runWith>[1]>;

export async function runWithReview(options: {
  model: ModelAdapter;
  enableReview?: boolean | ReviewOptions;
  run: () => Promise<void>;
  runWithOptions?: Omit<RunWithOptions, "model">;
}): Promise<void> {
  const reviewOptions = resolveReviewOptions(options.enableReview);
  const disableReview = reviewOptions ? enableReview(reviewOptions) : null;
  try {
    await runWith(options.run, {
      model: options.model,
      ...options.runWithOptions,
    });
  } finally {
    if (disableReview) {
      await disableReview();
    }
  }
}
