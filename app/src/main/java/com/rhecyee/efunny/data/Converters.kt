package com.rhecyee.efunny.data

import androidx.room.TypeConverter
import org.json.JSONObject

/**
 * Source params are a small, open-ended bag of strings -- `url` for RSS,
 * `subreddit` for Reddit, `query` for YouTube -- so they are stored as JSON
 * rather than as columns. Adding a param to one source type must not migrate the
 * table for all of them.
 *
 * `org.json` is part of the Android platform, so this costs no dependency.
 */
class Converters {

    @TypeConverter
    fun paramsToJson(params: Map<String, String>?): String =
        JSONObject(params.orEmpty() as Map<*, *>).toString()

    @TypeConverter
    fun jsonToParams(json: String?): Map<String, String> {
        if (json.isNullOrBlank()) return emptyMap()
        return try {
            val obj = JSONObject(json)
            obj.keys().asSequence().associateWith { obj.optString(it, "") }
        } catch (_: Exception) {
            // A corrupt row should cost that source its settings, not crash the
            // app on launch.
            emptyMap()
        }
    }
}
