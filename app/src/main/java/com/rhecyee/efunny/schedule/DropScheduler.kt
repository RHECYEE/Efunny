package com.rhecyee.efunny.schedule

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.rhecyee.efunny.EFunnyGraph
import com.rhecyee.efunny.core.schedule.ScheduledDrop
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Arms the 05:00 / 15:00 / 20:00 chain.
 *
 * Exact wall-clock times rule out `PeriodicWorkRequest`, whose flex window will
 * not reliably land on 05:00. So each drop is a one-shot with an initial delay,
 * and each run arms the next.
 *
 * The unique work name embeds the drop's instant. That matters: a worker
 * re-arming the chain from inside itself would otherwise be enqueueing against
 * the very name it is running under, and REPLACE on running work cancels it
 * mid-flight. Naming each drop separately makes the handoff collision-free, and
 * makes [ensureScheduled] naturally idempotent under KEEP.
 */
object DropScheduler {

    const val TAG_DROP = "efunny-drop"

    /** Observed by the UI to know whether a manual refresh is still running. */
    const val MANUAL_WORK = "efunny-manual"

    private const val SAFETY_NET_WORK = "efunny-safety-net"

    /**
     * Arms the next drop if it is not already armed. Safe to call as often as
     * you like -- on launch, on boot, after a settings change.
     */
    fun ensureScheduled(context: Context) {
        val next = EFunnyGraph.schedule(context).nextAfter(EFunnyGraph.clock.instant())
        enqueue(context, next, ExistingWorkPolicy.KEEP)
        ensureSafetyNet(context)
    }

    /**
     * Drops every pending drop and re-arms from scratch. Used when the drop time
     * zone changes, since every future fire time just moved.
     */
    fun reschedule(context: Context) {
        WorkManager.getInstance(context).cancelAllWorkByTag(TAG_DROP)
        val next = EFunnyGraph.schedule(context).nextAfter(EFunnyGraph.clock.instant())
        enqueue(context, next, ExistingWorkPolicy.REPLACE)
        ensureSafetyNet(context)
    }

    /** Runs a drop immediately, without waiting for its slot. Manual refresh and debug use this. */
    fun runNow(context: Context) {
        val schedule = EFunnyGraph.schedule(context)
        val now = EFunnyGraph.clock.instant()
        val slot = schedule.currentSlotAt(now)

        WorkManager.getInstance(context).enqueueUniqueWork(
            MANUAL_WORK,
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SpotlightWorker>()
                .setInputData(inputFor(slot.name, now))
                .setConstraints(constraints)
                .addTag(TAG_DROP)
                .build(),
        )
    }

    private fun enqueue(context: Context, drop: ScheduledDrop, policy: ExistingWorkPolicy) {
        val delay = Duration.between(EFunnyGraph.clock.instant(), drop.at).coerceAtLeast(Duration.ZERO)

        WorkManager.getInstance(context).enqueueUniqueWork(
            workName(drop.at),
            policy,
            OneTimeWorkRequestBuilder<SpotlightWorker>()
                .setInitialDelay(delay.toMillis(), TimeUnit.MILLISECONDS)
                .setInputData(inputFor(drop.slot.name, drop.at))
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
                .addTag(TAG_DROP)
                .build(),
        )
    }

    /**
     * A force-stop clears pending work and the chain dies silently. This daily
     * check re-arms it, and costs nothing when a drop is already pending.
     */
    private fun ensureSafetyNet(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            SAFETY_NET_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RearmWorker>(1, TimeUnit.DAYS)
                .setConstraints(Constraints.Builder().build())
                .build(),
        )
    }

    internal fun workName(at: Instant): String = "efunny-drop-${at.toEpochMilli()}"

    internal fun inputFor(slot: String, at: Instant): Data = Data.Builder()
        .putString(SpotlightWorker.KEY_SLOT, slot)
        .putLong(SpotlightWorker.KEY_SCHEDULED_FOR, at.toEpochMilli())
        .build()

    private val constraints: Constraints
        get() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
}
