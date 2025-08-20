import type { AgentContext, AgentRequest, AgentResponse } from "@agentuity/sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { google } from "googleapis";
import z from "zod";

const API_KEY = process.env.YT_API_KEY;
const BEN_DAVIS_CHANNEL_ID = "UCFvPgPdb_emE_bpMZq6hmJQ";
const THEO_CHANNEL_ID = "UCbRP3c757lWg9M-U7TyEkXA";

interface VideoData {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  link: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

interface CommentData {
  text: string;
  authorName: string;
  likeCount: number;
}

async function getRecentVideosFromChannel(
  channelId: string,
  maxResults: number = 20
): Promise<VideoData[]> {
  const yt = google.youtube({ version: "v3", auth: API_KEY });

  // First, get basic video info from search
  const searchResp = await yt.search.list({
    part: ["snippet"],
    channelId,
    type: ["video"],
    order: "date",
    maxResults,
  });

  const videos: VideoData[] = [];
  const videoIds: string[] = [];

  // Extract video IDs and basic info
  for (const item of searchResp.data.items || []) {
    const videoId = item.id?.videoId;
    if (!videoId) continue;

    const snippet = item.snippet;
    videoIds.push(videoId);

    videos.push({
      videoId,
      title: snippet?.title || "",
      description: snippet?.description || "",
      publishedAt: snippet?.publishedAt || "",
      link: `https://www.youtube.com/watch?v=${videoId}`,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
    });
  }

  // Get detailed statistics for all videos in batch
  if (videoIds.length > 0) {
    const statsResp = await yt.videos.list({
      part: ["statistics", "contentDetails"],
      id: videoIds,
    });

    // Create a map of video_id to stats
    const statsMap: Record<string, any> = {};
    for (const item of statsResp.data.items || []) {
      const vidId = item.id;
      if (vidId) {
        statsMap[vidId] = {
          statistics: item.statistics || {},
          contentDetails: item.contentDetails || {},
        };
      }
    }

    // Merge stats into video objects
    for (const video of videos) {
      const vidId = video.videoId;
      if (vidId in statsMap) {
        const stats = statsMap[vidId].statistics;
        video.viewCount = parseInt(stats.viewCount || "0");
        video.likeCount = parseInt(stats.likeCount || "0");
        video.commentCount = parseInt(stats.commentCount || "0");
      }
    }
  }

  return videos;
}

async function getVideoComments(
  videoId: string,
  maxResults: number = 40
): Promise<CommentData[]> {
  const yt = google.youtube({ version: "v3", auth: API_KEY });

  try {
    const commentsResp = await yt.commentThreads.list({
      part: ["snippet", "replies"],
      videoId,
      order: "relevance",
      maxResults,
      textFormat: "plainText",
    });

    const comments: CommentData[] = [];

    for (const item of commentsResp.data.items || []) {
      const snippet = item.snippet;
      const topComment = snippet?.topLevelComment?.snippet;

      if (topComment) {
        comments.push({
          text: topComment.textDisplay || "",
          authorName: topComment.authorDisplayName || "",
          likeCount: topComment.likeCount || 0,
        });
      }
    }

    return comments;
  } catch (error) {
    throw new Error(`Failed to fetch comments for video ${videoId}: ${error}`);
  }
}

const getRecentYouTubeVideosTool = tool({
  description: "Get the recent videos from a YouTube channel",
  inputSchema: z.object({
    channel_id: z.enum(["Ben Davis", "Theo"]),
  }),
  execute: async ({ channel_id }, { abortSignal }) => {
    const resolvedChannelId =
      channel_id === "Ben Davis" ? BEN_DAVIS_CHANNEL_ID : THEO_CHANNEL_ID;

    try {
      const videos = await getRecentVideosFromChannel(resolvedChannelId, 20);
      return {
        channelKey: channel_id,
        channelId: resolvedChannelId,
        source: "youtube_api_v3",
        fetchedAt: new Date().toISOString(),
        videoCount: videos.length,
        videos,
      };
    } catch (error) {
      return {
        channelKey: channel_id,
        channelId: resolvedChannelId,
        source: "youtube_api_v3",
        error: {
          type: "api_error",
          message: String(error),
        },
      };
    }
  },
});

const getVideoCommentsTool = tool({
  description: "Get the top comments for a specific YouTube video",
  inputSchema: z.object({
    video_id: z.string(),
    max_results: z.number().min(1).max(50).default(40).optional(),
  }),
  execute: async ({ video_id, max_results = 40 }) => {
    try {
      const comments = await getVideoComments(video_id, max_results);
      return {
        videoId: video_id,
        source: "youtube_api_v3",
        fetchedAt: new Date().toISOString(),
        commentCount: comments.length,
        maxResults: max_results,
        comments,
      };
    } catch (error) {
      return {
        videoId: video_id,
        source: "youtube_api_v3",
        error: {
          type: "api_error",
          message: String(error),
        },
      };
    }
  },
});

// These tools need access to ctx, so they'll be created inside the Agent function

const SYSTEM_PROMPT = `
You are a background YouTube channel analyst that maintains living notes about videos on two channels: Ben Davis and Theo.

Your tools:

- get_recent_youtube_videos(channel: "Ben Davis" | "Theo")
- get_video_comments(video_id)
- save_video_memory(video_id, memory: string)
- get_video_memory(video_id)

Important rules:

- In your written output, refer to videos by title, not by video ID. Video IDs are allowed only in tool arguments.
- Work incrementally. Prefer diffing and updating existing memory over rewriting.
- Only request comments for new videos or videos from the last 72 hours unless a video is flagged as anomalous or has active discussion worth revisiting.
- For comments, you care about: (a) edit mistakes, broken/missing links, factual corrections; (b) sponsor mentions (positive/negative); (c) common themes; (d) unusually high like counts.
- Abnormal performance: compute views per hour since publish and compare to the channel's rolling median with a robust z-score. Consider |z| ≥ 2 as anomalous. If rolling stats are unavailable, be conservative.
- Output should be concise, structured, and actionable. Save durable insights in memory with save_video_memory.

Output format per run:

1. Priority alerts (if any): short bullets with title and why it matters.
2. New or changed videos: brief note per video including performance vs baseline and comment sentiment themes.
3. Channel-level trends: quick bullets on what's working or not.
`;

const HOURLY_PROMPT = (timestamp: string) => `
Hourly status run for ${timestamp}.

- Check both channels for new videos since the last run.
- For videos ≤ 72 hours old or previously flagged, sample comments (top liked + newest + keyword hits).
- Update per-video memory only if there's a meaningful change (new anomalies, new themes, corrections, sponsor sentiment shift).
- Return the run summary using the required output format.
`;

export default async function Agent(
  req: AgentRequest,
  resp: AgentResponse,
  ctx: AgentContext
) {
  try {
    let stepIdx = 1;

    // Create KV tools with access to ctx
    const saveVideoMemoryTool = tool({
      description:
        "Save the agent's findings, thoughts, and analysis for a specific video",
      inputSchema: z.object({
        video_id: z.string(),
        memory: z.string(),
      }),
      execute: async ({ video_id, memory }) => {
        try {
          await ctx.kv.set("video_memories", video_id, memory);
          ctx.logger.info(`Successfully saved memory for video ${video_id}`);
          return {
            videoId: video_id,
            action: "saved",
            timestamp: new Date().toISOString(),
            memoryLength: memory.length,
          };
        } catch (error) {
          ctx.logger.error("Failed to save video memory:", error);
          return {
            videoId: video_id,
            action: "save_failed",
            error: {
              type: "kv_error",
              message: String(error),
            },
          };
        }
      },
    });

    const getVideoMemoryTool = tool({
      description:
        "Retrieve the agent's previously saved memory/analysis for a specific video",
      inputSchema: z.object({
        video_id: z.string(),
      }),
      execute: async ({ video_id }) => {
        try {
          const memory = await ctx.kv.get("video_memories", video_id);
          if (memory === null) {
            ctx.logger.info(`No memory found for video ${video_id}`);
            return {
              videoId: video_id,
              action: "retrieved",
              found: false,
              memory: null,
            };
          } else {
            ctx.logger.info(
              `Successfully retrieved memory for video ${video_id}`
            );
            const memoryText = await memory.data.text();
            return {
              videoId: video_id,
              action: "retrieved",
              found: true,
              memory: memoryText,
              memoryLength: memoryText.length,
            };
          }
        } catch (error) {
          ctx.logger.error("Failed to retrieve video memory:", error);
          return {
            videoId: video_id,
            action: "retrieve_failed",
            error: {
              type: "kv_error",
              message: String(error),
            },
          };
        }
      },
    });

    const result = await generateText({
      model: openai("gpt-5"),
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
      system: SYSTEM_PROMPT,
      tools: {
        get_recent_youtube_videos: getRecentYouTubeVideosTool,
        get_video_comments: getVideoCommentsTool,
        save_video_memory: saveVideoMemoryTool,
        get_video_memory: getVideoMemoryTool,
      },
      messages: [
        {
          role: "user",
          content: HOURLY_PROMPT(new Date().toISOString()),
        },
      ],
      stopWhen: stepCountIs(40),
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
            toolResult.toolCallId
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
