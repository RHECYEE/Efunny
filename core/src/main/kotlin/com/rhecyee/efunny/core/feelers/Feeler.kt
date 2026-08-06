package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow

/**
 * One source of candidates. Every platform sits behind this interface, which is
 * the decision that lets Reddit stand in for Facebook groups today and lets
 * Instagram light up later as a config change rather than a rewrite.
 */
interface Feeler {
    val type: SourceType

    /**
     * Candidates published inside [window]. Return generously -- scoring and both
     * dedup passes trim hard, and a source that returns exactly its quota will
     * come up empty once a day of already-shown posts is filtered out.
     */
    suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult
}

/**
 * A feeler outcome.
 *
 * [Unavailable] is a return value, not an exception, because a dead source is an
 * ordinary daily event here -- a quota ceiling, a flaky feed, a platform with no
 * legal API. The compiler needs to reason about it and redistribute the slot,
 * not catch it.
 */
sealed interface FeelerResult {
    data class Success(val posts: List<RawPost>) : FeelerResult
    data class Unavailable(val reason: String) : FeelerResult
}
