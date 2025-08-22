import { readFileSync, writeFileSync, existsSync } from "fs";

const AGENT_ENDPOINT =
  "https://agentuity.ai/api/05bf94532a044d2de4ec170d31d9e992";
const AUTH_TOKEN = "wht_003536df5b8a459a9ac046fac9085f24";
const VIDEO_IDS_FILE = "all-video-ids-2025-08-22.json";
const PROGRESS_FILE = "ben-davis-comments-progress.json";
const BATCH_SIZE = 10;

interface VideoIdsData {
  fetchedAt: string;
  channels: Array<{
    channelId: string;
    channelName: string;
    videoIds: string[];
    totalCount: number;
  }>;
  totalVideos: number;
}

interface ProgressData {
  startedAt: string;
  lastUpdated: string;
  totalVideos: number;
  completedVideos: number;
  successfulVideos: string[];
  failedVideos: Array<{
    videoId: string;
    error: string;
    timestamp: string;
  }>;
  currentBatch: number;
  totalBatches: number;
}

async function makeCommentRequest(videoId: string): Promise<boolean> {
  console.log(`  🔄 ${videoId} - Starting request...`);
  try {
    const response = await fetch(AGENT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ videoId }),
    });

    if (response.ok) {
      console.log(`  ✅ ${videoId} - Success`);
      return true;
    } else {
      console.log(
        `  ❌ ${videoId} - HTTP ${response.status}: ${response.statusText}`
      );
      return false;
    }
  } catch (error) {
    console.log(`  ❌ ${videoId} - Error: ${error}`);
    return false;
  }
}

function loadProgress(): ProgressData | null {
  if (!existsSync(PROGRESS_FILE)) {
    return null;
  }

  try {
    const data = readFileSync(PROGRESS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.log(`Warning: Could not load progress file: ${error}`);
    return null;
  }
}

function saveProgress(progress: ProgressData): void {
  progress.lastUpdated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function getBenDavisVideoIds(): string[] {
  try {
    const data: VideoIdsData = JSON.parse(
      readFileSync(VIDEO_IDS_FILE, "utf-8")
    );
    const benDavisChannel = data.channels.find(
      (channel) => channel.channelName === "Ben Davis"
    );

    if (!benDavisChannel) {
      throw new Error("Ben Davis channel not found in video IDs file");
    }

    return benDavisChannel.videoIds;
  } catch (error) {
    console.error(`Error reading video IDs file: ${error}`);
    process.exit(1);
  }
}

async function processBatch(
  videoIds: string[],
  progress: ProgressData
): Promise<void> {
  console.log(
    `\n🚀 Processing batch ${progress.currentBatch}/${progress.totalBatches}`
  );
  console.log(`Videos in this batch: ${videoIds.length}`);

  const batchResults = await Promise.allSettled(
    videoIds.map(async (videoId) => {
      const success = await makeCommentRequest(videoId);
      return { videoId, success };
    })
  );

  for (const result of batchResults) {
    if (result.status === "fulfilled") {
      const { videoId, success } = result.value;
      if (success) {
        progress.successfulVideos.push(videoId);
      } else {
        progress.failedVideos.push({
          videoId,
          error: "Request failed",
          timestamp: new Date().toISOString(),
        });
      }
      progress.completedVideos++;
    } else {
      console.log(`  ❌ Batch processing error: ${result.reason}`);
    }
  }

  progress.currentBatch++;
  saveProgress(progress);

  const successCount = batchResults.filter(
    (r) => r.status === "fulfilled" && r.value.success
  ).length;

  console.log(
    `✨ Batch complete: ${successCount}/${videoIds.length} successful`
  );
  console.log(
    `📊 Overall progress: ${progress.completedVideos}/${
      progress.totalVideos
    } (${Math.round((progress.completedVideos / progress.totalVideos) * 100)}%)`
  );
}

async function main() {
  console.log("🎬 Starting Ben Davis comments parsing...");

  const allVideoIds = getBenDavisVideoIds();
  console.log(`📹 Found ${allVideoIds.length} Ben Davis videos to process`);

  let progress = loadProgress();
  let remainingVideoIds: string[];

  if (progress) {
    console.log(`📂 Resuming from previous run...`);
    console.log(`   Started: ${progress.startedAt}`);
    console.log(
      `   Completed: ${progress.completedVideos}/${progress.totalVideos}`
    );
    console.log(`   Successful: ${progress.successfulVideos.length}`);
    console.log(`   Failed: ${progress.failedVideos.length}`);

    // Get remaining video IDs (ones not yet processed)
    const processedVideoIds = new Set([
      ...progress.successfulVideos,
      ...progress.failedVideos.map((f) => f.videoId),
    ]);
    remainingVideoIds = allVideoIds.filter((id) => !processedVideoIds.has(id));

    console.log(`   Remaining: ${remainingVideoIds.length} videos`);
  } else {
    console.log(`🆕 Starting fresh run...`);
    remainingVideoIds = [...allVideoIds];

    const totalBatches = Math.ceil(remainingVideoIds.length / BATCH_SIZE);
    progress = {
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalVideos: allVideoIds.length,
      completedVideos: 0,
      successfulVideos: [],
      failedVideos: [],
      currentBatch: 1,
      totalBatches,
    };

    saveProgress(progress);
  }

  if (remainingVideoIds.length === 0) {
    console.log("🎉 All videos have already been processed!");
    return;
  }

  // Process in batches
  for (let i = 0; i < remainingVideoIds.length; i += BATCH_SIZE) {
    const batch = remainingVideoIds.slice(i, i + BATCH_SIZE);
    await processBatch(batch, progress);

    // Add a small delay between batches to be respectful to the API
    if (i + BATCH_SIZE < remainingVideoIds.length) {
      console.log("⏳ Waiting 2 seconds before next batch...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log("\n🎉 All batches completed!");
  console.log(`📊 Final results:`);
  console.log(`   Total videos: ${progress.totalVideos}`);
  console.log(`   Successful: ${progress.successfulVideos.length}`);
  console.log(`   Failed: ${progress.failedVideos.length}`);

  if (progress.failedVideos.length > 0) {
    console.log(`\n❌ Failed videos:`);
    progress.failedVideos.forEach((failed) => {
      console.log(`   ${failed.videoId} - ${failed.error}`);
    });
  }

  console.log(`\n💾 Progress saved to: ${PROGRESS_FILE}`);
}

main().catch((error) => {
  console.error("💥 Script failed:", error);
  process.exit(1);
});
