import type { AgentContext, AgentRequest, AgentResponse } from "@agentuity/sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { google } from "googleapis";
import { ResultAsync } from "neverthrow";
import z from "zod";

const DEFAULT_MAX_RESULTS = 200;
const KV_NAMESPACE = "comments-watcher";
const YT_API_KEY = process.env.YT_API_KEY;

if (!YT_API_KEY) {
  throw new Error("YT_API_KEY is not set");
}

const youtube = google.youtube({
  version: "v3",
  auth: YT_API_KEY,
});

class COMMENTS_AGENT_ERROR extends Error {
  constructor(message: string) {
    super(message);
    this.name = "COMMENTS_AGENT_ERROR";
  }
}

const inputJsonSchema = z.object({
  videoId: z.string(),
});

const getVideoInfo = async (data: { videoId: string; ctx: AgentContext }) => {
  const { videoId, ctx } = data;

  return ResultAsync.fromPromise(
    youtube.videos
      .list({
        part: ["snippet", "contentDetails", "statistics"],
        id: [videoId],
        maxResults: 1,
      })
      .then((r) => {
        const video = r.data.items?.[0];
        if (!video) return null;

        const thumbnails = video.snippet?.thumbnails;
        const thumbnail =
          thumbnails?.maxres?.url ||
          thumbnails?.high?.url ||
          thumbnails?.medium?.url ||
          thumbnails?.default?.url;

        return {
          title: video.snippet?.title,
          description: video.snippet?.description,
          channelTitle: video.snippet?.channelTitle,
          publishedAt: video.snippet?.publishedAt,
          duration: video.contentDetails?.duration,
          viewCount: video.statistics?.viewCount,
          likeCount: video.statistics?.likeCount,
          commentCount: video.statistics?.commentCount,
          thumbnail,
        };
      }),
    (e) => {
      ctx.logger.error(e);
      return new COMMENTS_AGENT_ERROR(
        `Failed to get video info for videoId: ${videoId}`
      );
    }
  );
};

const getTopComments = async (data: {
  videoId: string;
  maxResults?: number;
  ctx: AgentContext;
}) => {
  const { videoId, maxResults = DEFAULT_MAX_RESULTS, ctx } = data;

  return ResultAsync.fromPromise(
    youtube.commentThreads
      .list({
        part: ["snippet", "replies"],
        videoId,
        order: "relevance",
        maxResults,
        textFormat: "plainText",
      })
      .then((r) => {
        return (r.data.items ?? []).map((item) => ({
          text: item.snippet?.topLevelComment?.snippet?.textDisplay,
          authorName: item.snippet?.topLevelComment?.snippet?.authorDisplayName,
          likeCount: item.snippet?.topLevelComment?.snippet?.likeCount,
          publishedAt: item.snippet?.topLevelComment?.snippet?.publishedAt,
          replyCount: item.snippet?.totalReplyCount,
          replies:
            item.replies?.comments?.map((reply) => ({
              text: reply.snippet?.textDisplay,
              authorName: reply.snippet?.authorDisplayName,
              likeCount: reply.snippet?.likeCount,
              publishedAt: reply.snippet?.publishedAt,
            })) || [],
        }));
      }),
    (e) => {
      ctx.logger.error(e);
      return new COMMENTS_AGENT_ERROR(
        `Failed to get top comments for videoId: ${videoId}`
      );
    }
  );
};

const readFromMemory = async (data: { key: string; ctx: AgentContext }) => {
  const { key, ctx } = data;

  return ResultAsync.fromPromise(
    ctx.kv.get(KV_NAMESPACE, key).then((r) => r.data.text()),
    (e) => {
      ctx.logger.error(e);
      return new COMMENTS_AGENT_ERROR(
        `Failed to read from memory for key: ${key}`
      );
    }
  );
};

const writeToMemory = async (data: {
  key: string;
  value: string;
  ctx: AgentContext;
}) => {
  const { key, value, ctx } = data;

  return ResultAsync.fromPromise(ctx.kv.set(KV_NAMESPACE, key, value), (e) => {
    ctx.logger.error(e);
    return new COMMENTS_AGENT_ERROR(
      `Failed to write to memory for key: ${key}`
    );
  });
};

// TOOLS
const getVideoInfoTool = (ctx: AgentContext) =>
  tool({
    description:
      "Get all of the information about a video (not including comments)",
    inputSchema: z.object({
      videoId: z.string(),
    }),
    execute: async ({ videoId }) => {
      const videoInfo = await getVideoInfo({ videoId, ctx });
      if (videoInfo.isErr()) {
        return {
          success: false,
          error: videoInfo.error,
          message: `Failed to get video info for videoId: ${videoId}`,
        };
      }
      return {
        success: true,
        data: videoInfo.value,
      };
    },
  });

const getTopCommentsTool = (ctx: AgentContext) =>
  tool({
    description: `Get the top comments for a video, does not include full video details. The maxResults parameter is optional and defaults to ${DEFAULT_MAX_RESULTS}.`,
    inputSchema: z.object({
      videoId: z.string(),
      maxResults: z.number().optional(),
    }),
    execute: async ({ videoId, maxResults }) => {
      const topComments = await getTopComments({ videoId, ctx, maxResults });
      if (topComments.isErr()) {
        return {
          success: false,
          error: topComments.error,
          message: `Failed to get top comments for videoId: ${videoId}`,
        };
      }
      return {
        success: true,
        data: topComments.value,
      };
    },
  });

const writeToMemoryTool = (ctx: AgentContext) =>
  tool({
    description: "Write to your memory",
    inputSchema: z.object({
      videoId: z.string(),
      value: z.string(),
    }),
    execute: async ({ videoId, value }) => {
      const result = await writeToMemory({ key: videoId, value, ctx });
      if (result.isErr()) {
        return {
          success: false,
          error: result.error,
          message: `Failed to write to memory for videoId: ${videoId}`,
        };
      }
      return {
        success: true,
        data: result.value,
      };
    },
  });

const readFromMemoryTool = (ctx: AgentContext) =>
  tool({
    description: "Read from your memory",
    inputSchema: z.object({
      videoId: z.string(),
    }),
    execute: async ({ videoId }) => {
      const result = await readFromMemory({ key: videoId, ctx });
      if (result.isErr()) {
        return {
          success: false,
          error: result.error,
          message: `Failed to read from memory for videoId: ${videoId}`,
        };
      }
      return {
        success: true,
        data: result.value,
      };
    },
  });

const SYSTEM_PROMPT = `
You are an internal background agent who's job is to monitor youtube videos, their stats, and their comments.

You have access to tools that can get the top comments for a video and the full video info. You also have access to tools for saving and writing to a kv store (your memory).

You will be given a videoId and then you will need to create a snapshot summary of a video. (you should keep track of when the snapshot was taken as well)

Make sure you check for any existing memory for this videoId. If there is, you should use that as a starting point. Remember the memory is being saved to a kv store, so whatever you save will overwrite the previous memory (make sure not to loose any important information).

The snapshot must be in markdown format.

Things that should be included:

- Title
- Description
- Channel Title
- Published At
- Duration
- View Count
- Like Count
- Comment Count
- Thumbnail

Also while getting those stats look for things like views per hour, how recent the video is, etc.

You will also need to analyze the top comments for the video.

TOP PRIORITY COMMENTS THAT MUST BE FLAGGED AND SAVED:

- Comments that are critical of the video's sponsor
- Comments that are positive about the video's sponsor
- Comments flagging an editing mistake
- Comments flagging a mistake in the description (missing link, etc)

For the rest of the comments you should be looking to gather high level information on the sentiment and what people are saying about the video.

In comments/reviews there may be hundreds of them, but in reality there are only a few "comments" that just get repeated. For example if people are upset about the video feeling biased, they will all just say the same thing over and over. Your job is to pick out the 5-10 unique "comments" on the video and save them to your memory.

Also go through and save the general sentiment.

At the bottom of your memory you can save anything else you think is important.

Godspeed.
`;

export default async function Agent(
  req: AgentRequest,
  resp: AgentResponse,
  ctx: AgentContext
) {
  const jsonResult = await ResultAsync.fromPromise(req.data.json(), (e) => {
    return new COMMENTS_AGENT_ERROR(`Failed to parse request data`);
  });

  if (jsonResult.isErr()) {
    return resp.json({
      // TODO: these should be status codes but i don't fucking care right now
      success: false,
      error: jsonResult.error,
      message:
        "Invalid request data, must be a JSON object with a videoId property",
    });
  }

  const parseResult = inputJsonSchema.safeParse(jsonResult.value);

  if (!parseResult.success) {
    return resp.json({
      success: false,
      error: parseResult.error,
      message:
        "Invalid request data, must be a JSON object with a videoId property",
    });
  }

  let stepIdx = 1;

  const result = await ResultAsync.fromPromise(
    generateText({
      model: openai("gpt-5-mini"),
      providerOptions: {
        openai: {
          reasoningEffort: "high",
        },
      },
      system: SYSTEM_PROMPT,
      tools: {
        getVideoInfo: getVideoInfoTool(ctx),
        getTopComments: getTopCommentsTool(ctx),
        writeToMemory: writeToMemoryTool(ctx),
        readFromMemory: readFromMemoryTool(ctx),
      },
      messages: [
        {
          role: "user",
          content: `videoId: ${parseResult.data.videoId}`,
        },
      ],
      stopWhen: stepCountIs(10),
      onStepFinish: (step) => {
        ctx.logger.info(`FINISHED STEP ${stepIdx}`);
        stepIdx += 1;

        ctx.logger.info(step.toolCalls.length, "tool calls made");
        step.toolCalls.forEach((toolCall) => {
          ctx.logger.info(toolCall.toolName, "tool called", toolCall.input);
        });
      },
    }),
    (e) => {
      ctx.logger.error(e);
      return new COMMENTS_AGENT_ERROR(`Failed to generate text`);
    }
  );

  if (result.isErr()) {
    return resp.json({
      success: false,
      error: result.error,
      message: `Failed to generate text`,
    });
  }

  ctx.logger.info(`FINISHED AFTER ${stepIdx} STEPS`);

  ctx.logger.info(result.value.text);

  return resp.json(result.value.text);
}
