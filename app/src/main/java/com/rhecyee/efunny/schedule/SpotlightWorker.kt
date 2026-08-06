package com.rhecyee.efunny.schedule

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.rhecyee.efunny.EFunnyGraph
import com.rhecyee.efunny.core.schedule.DropSlot
import java.time.Instant

/**
 * Compiles one drop, announces it, and arms the next.
 *
 * The slot and its scheduled instant come in as input rather than being read
 * from the clock, so a worker that fires late -- deferred for network, or held
 * by Doze -- still writes to the 15:00 drop instead of creating a fourth one.
 */
class SpotlightWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val schedule = EFunnyGraph.schedule(applicationContext)
        val now = EFunnyGraph.clock.instant()

        val slot = inputData.getString(KEY_SLOT)
            ?.let { runCatching { DropSlot.valueOf(it) }.getOrNull() }
            ?: schedule.currentSlotAt(now)

        val scheduledFor = inputData.getLong(KEY_SCHEDULED_FOR, 0L)
            .takeIf { it > 0L }
            ?.let(Instant::ofEpochMilli)
            ?: now

        return try {
            val drop = EFunnyGraph.repository(applicationContext).runDrop(slot, scheduledFor)
            DropNotifier.announce(applicationContext, slot, drop.entries.size)
            Result.success()
        } catch (e: Exception) {
            // Retry with backoff -- a transient network failure should not cost
            // the user the drop entirely.
            if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.failure()
        } finally {
            // Arm the next slot whatever happened here. A failed drop must not
            // break the chain, or the app goes quiet until the daily safety net
            // notices.
            DropScheduler.ensureScheduled(applicationContext)
        }
    }

    companion object {
        const val KEY_SLOT = "slot"
        const val KEY_SCHEDULED_FOR = "scheduled_for"
        private const val MAX_ATTEMPTS = 3
    }
}

/**
 * The daily safety net. A force-stop clears pending work, so something outside
 * the chain has to be able to restart it.
 */
class RearmWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        DropScheduler.ensureScheduled(applicationContext)
        return Result.success()
    }
}
