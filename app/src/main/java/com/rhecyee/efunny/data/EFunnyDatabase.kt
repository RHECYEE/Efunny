package com.rhecyee.efunny.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import com.rhecyee.efunny.core.model.DefaultSources
import com.rhecyee.efunny.core.model.SourceConfig

@Database(
    entities = [
        SourceConfigEntity::class,
        PostEntity::class,
        SpotlightEntity::class,
        SpotlightEntryEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class EFunnyDatabase : RoomDatabase() {

    abstract fun dao(): EFunnyDao

    companion object {
        @Volatile
        private var instance: EFunnyDatabase? = null

        fun get(context: Context): EFunnyDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                EFunnyDatabase::class.java,
                "efunny.db",
            ).build().also { instance = it }
        }
    }
}

/** Room row -> core model. The core module knows nothing about Android or Room. */
fun SourceConfigEntity.toCore(): SourceConfig = SourceConfig(
    id = id,
    type = enumValueOf(type),
    displayName = displayName,
    params = params,
    quotaPerDrop = quotaPerDrop,
    enabled = enabled,
    position = position,
)

fun SourceConfig.toEntity(lastResult: String? = null, lastFetchedAt: Long? = null) = SourceConfigEntity(
    id = id,
    type = type.name,
    displayName = displayName,
    params = params,
    quotaPerDrop = quotaPerDrop,
    enabled = enabled,
    position = position,
    lastResult = lastResult,
    lastFetchedAt = lastFetchedAt,
)

/** The rows a fresh install starts with. */
fun defaultSourceEntities(): List<SourceConfigEntity> = DefaultSources.ALL.map { it.toEntity() }
