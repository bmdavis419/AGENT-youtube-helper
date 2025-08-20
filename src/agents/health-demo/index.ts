import type { AgentContext, AgentRequest, AgentResponse } from "@agentuity/sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import z from "zod";

const weightTool = tool({
  description: "Get a user's height",
  inputSchema: z.object({
    userName: z.string(),
  }),
  execute: async ({ userName }) => {
    return `The user ${userName} weighs 196.3 pounds`;
  },
});

const sexTool = tool({
  description: "Get a user's sex",
  inputSchema: z.object({
    userName: z.string(),
  }),
  execute: async ({ userName }) => {
    return `The user ${userName} is male`;
  },
});

const ageTool = tool({
  description: "Get a user's age",
  inputSchema: z.object({
    userName: z.string(),
  }),
  execute: async ({ userName }) => {
    return `The user ${userName} is 23 years old`;
  },
});

const bodyFatTool = tool({
  description: "Get a user's body fat percentage",
  inputSchema: z.object({
    userName: z.string(),
  }),
  execute: async ({ userName }) => {
    return `The user ${userName} has a body fat percentage of 22%`;
  },
});

const heightTool = tool({
  description: "Get a user's height",
  inputSchema: z.object({
    userName: z.string(),
  }),
  execute: async ({ userName }) => {
    return `The user ${userName} is 5 feet 9 inches tall`;
  },
});

export default async function Agent(
  req: AgentRequest,
  resp: AgentResponse,
  ctx: AgentContext
) {
  try {
    let stepIdx = 1;
    const result = await generateText({
      model: openai("gpt-5-mini"),
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
      system:
        "You are a helpful assistant for helping users with their health. You have access to tools that can check the user's weight, body fat percentage, height, sex, and age from our database.",
      tools: {
        checkUserWeight: weightTool,
        checkUserBodyFat: bodyFatTool,
        checkUserHeight: heightTool,
        checkUserSex: sexTool,
        checkUserAge: ageTool,
      },
      messages: [
        {
          role: "system",
          content: "you are currently helping user: bean",
        },
        {
          role: "user",
          content:
            "Run a check on my health. How do my stats compare to others around my age? Do I have a decent amount of muscle, what changes should I push for to get healthier?",
        },
      ],
      stopWhen: stepCountIs(10),
      onStepFinish: (step) => {
        console.log("FINISHED STEP", stepIdx);
        stepIdx += 1;

        console.log(step.toolCalls.length, "tool calls made");
        step.toolCalls.forEach((toolCall) => {
          console.log(toolCall.toolName, "tool called");
        });

        console.log(step.toolResults.length, "tool results");
        step.toolResults.forEach((toolResult) => {
          console.log(
            toolResult.output,
            "tool result for",
            toolResult.toolName
          );
        });
      },
    });

    console.log("finished after", stepIdx - 1, "steps");

    return resp.text(result.text);
  } catch (error) {
    ctx.logger.error("Error running agent:", error);

    return resp.text("Sorry, there was an error processing your request.");
  }
}
