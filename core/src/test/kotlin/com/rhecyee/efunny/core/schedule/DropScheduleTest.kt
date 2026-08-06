package com.rhecyee.efunny.core.schedule

import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DropScheduleTest {

    private val schedule = DropSchedule(ZoneId.of("America/Denver"))

    @Test
    fun `picks the next slot later the same day`() {
        // 2026-08-06 12:00Z is 06:00 MDT -- past the morning drop, before the afternoon one.
        val next = schedule.nextAfter(Instant.parse("2026-08-06T12:00:00Z"))
        assertEquals(DropSlot.AFTERNOON, next.slot)
        assertEquals(Instant.parse("2026-08-06T21:00:00Z"), next.at, "15:00 MDT is 21:00Z")
    }

    @Test
    fun `rolls over to tomorrow morning after the evening drop`() {
        // 23:00 MDT on the 6th: every slot today has fired.
        val next = schedule.nextAfter(Instant.parse("2026-08-07T05:00:00Z"))
        assertEquals(DropSlot.MORNING, next.slot)
        assertEquals(Instant.parse("2026-08-07T11:00:00Z"), next.at, "05:00 MDT is 11:00Z")
    }

    @Test
    fun `spring forward shifts the drop an hour earlier in UTC`() {
        // Mountain Time enters MDT at 02:00 local on 8 Mar 2026. The 05:00 drop
        // is 12:00Z the day before and 11:00Z the day after. A hardcoded UTC-7
        // offset would fire this an hour late for the next eight months.
        val beforeTransition = schedule.nextAfter(Instant.parse("2026-03-07T06:00:00Z"))
        assertEquals(Instant.parse("2026-03-07T12:00:00Z"), beforeTransition.at, "05:00 MST is 12:00Z")

        val afterTransition = schedule.nextAfter(Instant.parse("2026-03-08T06:00:00Z"))
        assertEquals(Instant.parse("2026-03-08T11:00:00Z"), afterTransition.at, "05:00 MDT is 11:00Z")
    }

    @Test
    fun `fall back shifts the drop an hour later in UTC`() {
        // Mountain Time returns to MST at 02:00 local on 1 Nov 2026.
        val next = schedule.nextAfter(Instant.parse("2026-11-01T03:00:00Z"))
        assertEquals(DropSlot.MORNING, next.slot)
        assertEquals(Instant.parse("2026-11-01T12:00:00Z"), next.at, "05:00 MST is 12:00Z")
    }

    @Test
    fun `fires exactly three drops on every day of the year including both DST days`() {
        // Walking a full year is the test that would actually catch a skipped or
        // doubled drop at a transition -- the two spot checks above only prove
        // the boundary instants.
        // Start just after the last drop of 2025 and end just before the first
        // of 2027, so the walk covers exactly the local days of 2026 and no
        // partial day at either edge skews the count.
        var cursor = Instant.parse("2026-01-01T04:00:00Z") // 21:00 MST on 31 Dec 2025
        val end = Instant.parse("2027-01-01T12:00:00Z")    // 05:00 MST on 1 Jan 2027

        val perLocalDate = mutableMapOf<String, MutableList<DropSlot>>()
        while (true) {
            val next = schedule.nextAfter(cursor)
            if (!next.at.isBefore(end)) break
            assertTrue(next.at.isAfter(cursor), "schedule must always advance")
            val date = next.at.atZone(schedule.zone).toLocalDate().toString()
            perLocalDate.getOrPut(date) { mutableListOf() } += next.slot
            cursor = next.at
        }

        assertEquals(365, perLocalDate.size, "2026 has 365 days")
        perLocalDate.forEach { (date, slots) ->
            assertEquals(
                listOf(DropSlot.MORNING, DropSlot.AFTERNOON, DropSlot.EVENING),
                slots,
                "$date should get all three drops exactly once, in order",
            )
        }

        // The two days that would break a naive implementation.
        assertEquals(3, perLocalDate["2026-03-08"]?.size, "spring-forward day still gets three drops")
        assertEquals(3, perLocalDate["2026-11-01"]?.size, "fall-back day still gets three drops")
    }

    @Test
    fun `arizona does not observe DST so its drops never move`() {
        val phoenix = DropSchedule(ZoneId.of("America/Phoenix"))
        val winter = phoenix.nextAfter(Instant.parse("2026-01-15T06:00:00Z"))
        val summer = phoenix.nextAfter(Instant.parse("2026-07-15T06:00:00Z"))

        assertEquals(
            winter.at.atZone(phoenix.zone).toLocalTime(),
            summer.at.atZone(phoenix.zone).toLocalTime(),
        )
        assertEquals(Instant.parse("2026-01-15T12:00:00Z"), winter.at)
        assertEquals(Instant.parse("2026-07-15T12:00:00Z"), summer.at, "Phoenix stays UTC-7 year round")
    }

    @Test
    fun `labels the currently displayed drop`() {
        // 04:00 MDT -- before the morning drop, so the evening set is still the
        // freshest thing the user has.
        assertEquals(DropSlot.EVENING, schedule.currentSlotAt(Instant.parse("2026-08-06T10:00:00Z")))
        assertEquals(DropSlot.MORNING, schedule.currentSlotAt(Instant.parse("2026-08-06T14:00:00Z")))
        assertEquals(DropSlot.AFTERNOON, schedule.currentSlotAt(Instant.parse("2026-08-06T22:00:00Z")))
        assertEquals(DropSlot.EVENING, schedule.currentSlotAt(Instant.parse("2026-08-07T03:00:00Z")))
    }

    @Test
    fun `lists all three drops for the day`() {
        val drops = schedule.dropsOnDayOf(Instant.parse("2026-08-06T18:00:00Z"))
        assertEquals(3, drops.size)
        assertEquals(listOf(DropSlot.MORNING, DropSlot.AFTERNOON, DropSlot.EVENING), drops.map { it.slot })
        assertTrue(drops.zipWithNext().all { (a, b) -> a.at.isBefore(b.at) }, "should be chronological")
    }
}
