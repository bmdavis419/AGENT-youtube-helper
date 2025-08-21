import type { AgentContext, AgentRequest, AgentResponse } from "@agentuity/sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { google } from "googleapis";
import { ResultAsync } from "neverthrow";
import z from "zod";

const DEFAULT_MAX_RESULTS = 100;
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

const getVideoInfo = async (data: { videoId: string }) => {
  const { videoId } = data;

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
      console.error(e);
      return new COMMENTS_AGENT_ERROR(
        `Failed to get video info for videoId: ${videoId}`
      );
    }
  );
};

const getTopComments = async (data: {
  videoId: string;
  maxResults?: number;
}) => {
  const { videoId, maxResults = DEFAULT_MAX_RESULTS } = data;

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
      console.error(e);
      return new COMMENTS_AGENT_ERROR(
        `Failed to get top comments for videoId: ${videoId}`
      );
    }
  );
};

// TOOLS
const getVideoInfoTool = tool({
  description:
    "Get all of the information about a video (not including comments)",
  inputSchema: z.object({
    videoId: z.string(),
  }),
  execute: async ({ videoId }) => {
    const videoInfo = await getVideoInfo({ videoId });
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

const getTopCommentsTool = tool({
  description:
    "Get the top comments for a video, does not include full video details. The maxResults parameter is optional and defaults to 100.",
  inputSchema: z.object({
    videoId: z.string(),
    maxResults: z.number().optional(),
  }),
  execute: async ({ videoId }) => {
    const topComments = await getTopComments({ videoId });
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

  const result = await ResultAsync.fromPromise(
    generateText({
      model: openai("gpt-5-mini"),
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
      system:
        "You are an internal background agent who's job is to keep an eye on youtube videos. You have access to tools that can get the top comments for a video and the full video info.",
      tools: {
        getVideoInfo: getVideoInfoTool,
        getTopComments: getTopCommentsTool,
      },
      messages: [
        {
          role: "user",
          content: `Check the sentiment in the comments for this video: ${parseResult.data.videoId}. Give a full report on the video and how it's doing.`,
        },
      ],
      stopWhen: stepCountIs(10),
    }),
    (e) => {
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

  return resp.json(result.value.text);
}
