package com.rhecyee.efunny

import android.content.Context
import com.rhecyee.efunny.core.feelers.FacebookGroupsFeeler
import com.rhecyee.efunny.core.feelers.Feeler
import com.rhecyee.efunny.core.feelers.InstagramReelsFeeler
import com.rhecyee.efunny.core.feelers.RedditFeeler
import com.rhecyee.efunny.core.feelers.RssFeeler
import com.rhecyee.efunny.core.feelers.TikTokFeeler
import com.rhecyee.efunny.core.feelers.YouTubeShortsFeeler
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.net.Http
import com.rhecyee.efunny.core.net.OkHttpClientHttp
import com.rhecyee.efunny.core.schedule.DropSchedule
import com.rhecyee.efunny.core.spotlight.Deduper
import com.rhecyee.efunny.core.spotlight.SpotlightCompiler
import com.rhecyee.efunny.core.spotlight.SpotlightService
import com.rhecyee.efunny.core.spotlight.TrendScorer
import com.rhecyee.efunny.data.EFunnyDatabase
import com.rhecyee.efunny.data.SecureSettings
import com.rhecyee.efunny.data.SpotlightRepository
import java.time.Clock

/**
 * The object graph, wired by hand.
 *
 * There is no DI framework here on purpose: the whole graph is a dozen objects
 * with no cycles, and matching the sibling FIRE-MAPS project keeps both readable
 * by the same person.
 */
object EFunnyGraph {

    @Volatile
    private var repository: SpotlightRepository? = null

    @Volatile
    private var settings: SecureSettings? = null

    val clock: Clock = Clock.systemUTC()

    fun settings(context: Context): SecureSettings = settings ?: synchronized(this) {
        settings ?: SecureSettings(context.applicationContext, clock).also { settings = it }
    }

    fun schedule(context: Context) = DropSchedule(settings(context).dropZone())

    fun repository(context: Context): SpotlightRepository = repository ?: synchronized(this) {
        repository ?: build(context.applicationContext).also { repository = it }
    }

    private fun build(context: Context): SpotlightRepository {
        val secure = settings(context)
        val http: Http = OkHttpClientHttp()
        val deduper = Deduper()

        val feelers: Map<SourceType, Feeler> = mapOf(
            SourceType.RSS to RssFeeler(http),
            SourceType.REDDIT to RedditFeeler(http, secure, clock),
            SourceType.YOUTUBE_SHORTS to YouTubeShortsFeeler(http, secure, secure),
            // Registered but permanently unavailable in v1; each returns the
            // specific reason its platform is closed. See ClosedPlatformFeelers.
            SourceType.INSTAGRAM_REELS to InstagramReelsFeeler(),
            SourceType.TIKTOK to TikTokFeeler(),
            SourceType.FACEBOOK_GROUP to FacebookGroupsFeeler(),
        )

        val service = SpotlightService(
            feelers = feelers,
            compiler = SpotlightCompiler(TrendScorer(clock), deduper),
            clock = clock,
        )

        return SpotlightRepository(
            dao = EFunnyDatabase.get(context).dao(),
            service = service,
            deduper = deduper,
            clock = clock,
        )
    }
}
