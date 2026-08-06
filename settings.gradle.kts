pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "EFunny"

// :core is a plain Kotlin/JVM module on purpose. Everything that decides *what*
// lands in a Spotlight -- fetching, scoring, deduping, allocation, drop timing --
// lives there so it can be unit tested on any JVM without an Android SDK or an
// emulator. :app is the Android shell: Room, Compose, WorkManager, and wiring.
include(":core")
include(":app")
