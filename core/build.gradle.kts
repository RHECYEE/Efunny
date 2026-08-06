plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed") }
}

/**
 * Pulls a real day of drops off the live internet and prints them.
 *
 * Not wired into `check` on purpose -- it depends on the outside world, so a
 * feed having a bad morning must never fail the build. Run it by hand:
 *
 *     ./gradlew :core:liveBatch
 */
tasks.register<JavaExec>("liveBatch") {
    group = "verification"
    description = "Fetch a real Spotlight batch from live sources and print it"
    mainClass.set("com.rhecyee.efunny.core.LiveBatch")
    classpath = sourceSets["test"].runtimeClasspath
    environment("YOUTUBE_API_KEY", System.getenv("YOUTUBE_API_KEY") ?: "")
    environment("REDDIT_CLIENT_ID", System.getenv("REDDIT_CLIENT_ID") ?: "")
}
