const mongoose = require("mongoose");

const dbconnect = async () => {
    try {
        if (!process.env.MONGODB_URI) {
            throw new Error("MONGODB_URI is not defined in environment variables");
        }
        const uri = process.env.MONGODB_URI;
        const isLocal = /^mongodb:\/\/([^/@]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
        const hasCreds = /^mongodb(\+srv)?:\/\/[^/@]+:[^/@]+@/.test(uri);
        if (process.env.NODE_ENV === "production" && !hasCreds && !isLocal) {
            throw new Error("Refusing to start: production MONGODB_URI has no credentials");
        }
        if (process.env.NODE_ENV === "production" && isLocal && !hasCreds) {
            console.warn("WARNING: production database has no authentication. Enable Mongo auth.");
        }
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            maxPoolSize: 20,
        });

        console.log("Database Connected Successfully");

    } catch (error) {
        console.error("Database connection failed:", error.message);
        process.exit(1);
    }
};
module.exports = dbconnect;