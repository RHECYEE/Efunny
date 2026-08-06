package com.rhecyee.efunny.core.schedule

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** The three daily drops. */
enum class DropSlot(val localTime: LocalTime, val label: String) {
    MORNING(LocalTime.of(5, 0), "Morning"),
    AFTERNOON(LocalTime.of(15, 0), "Afternoon"),
    EVENING(LocalTime.of(20, 0), "Evening"),
}

data class ScheduledDrop(val slot: DropSlot, val at: Instant)

/**
 * Works out when the next drop fires.
 *
 * The zone is stored as a [ZoneId], never a fixed offset, and every fire time is
 * built through [ZonedDateTime]. Mountain Time swings between MST and MDT, so a
 * hardcoded `UTC-7` would silently fire an hour late for roughly half the year.
 * `America/Phoenix` is the right value for Arizona, which does not observe DST --
 * hence the zone being configurable rather than baked in.
 */
class DropSchedule(val zone: ZoneId = DEFAULT_ZONE) {

    /** The first drop strictly after [now]. */
    fun nextAfter(now: Instant): ScheduledDrop {
        val today = now.atZone(zone).toLocalDate()
        // Today and tomorrow is always enough: the earliest slot tomorrow is
        // later than any instant today.
        for (dayOffset in 0L..1L) {
            val date = today.plusDays(dayOffset)
            for (slot in ORDERED) {
                val at = ZonedDateTime.of(date, slot.localTime, zone).toInstant()
                if (at.isAfter(now)) return ScheduledDrop(slot, at)
            }
        }
        error("No drop found after $now in $zone; DropSlot must be non-empty")
    }

    /**
     * The slot whose drop most recently fired at or before [now] -- what the UI
     * labels the currently-displayed set.
     */
    fun currentSlotAt(now: Instant): DropSlot {
        val zoned = now.atZone(zone)
        val time = zoned.toLocalTime()
        return ORDERED.lastOrNull { !time.isBefore(it.localTime) } ?: ORDERED.last()
    }

    /** Every drop instant on the local date containing [now], earliest first. */
    fun dropsOnDayOf(now: Instant): List<ScheduledDrop> {
        val date = now.atZone(zone).toLocalDate()
        return ORDERED.map { ScheduledDrop(it, ZonedDateTime.of(date, it.localTime, zone).toInstant()) }
    }

    companion object {
        val DEFAULT_ZONE: ZoneId = ZoneId.of("America/Denver")
        private val ORDERED = DropSlot.entries.sortedBy { it.localTime }
    }
}
