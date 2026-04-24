const {
    onDocumentUpdated,
    onDocumentCreated,
} = require('firebase-functions/v2/firestore');

const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

admin.initializeApp()
const db = admin.firestore()

exports.updateUserInfoInReviews = onDocumentUpdated(
    "users/{userId}",
    async (event) => {
        const userId = event.params.userId;

        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();

        if(beforeData.username === afterData.username) {
            logger.log("No change in username, skipping update.");
            return;
        }

        logger.log("Actualizando reviews del usuario:", userId);

        const reviewsSnapshot = await db
            .collection("reviews")
            .where("userId", "==", userId)
            .get();

        const batch = db.batch();

        reviewsSnapshot.forEach((doc) => {
            batch.update(doc.ref, {
                "user.username": afterData.username
            })
        })

        await batch.commit();
        logger.log("Reviews actualizadas para el usuario:", userId);
    }
);

exports.sendLikeNotification = onDocumentCreated(
    "reviews/{reviewId}/likes/{likeId}",
    async (event) => {
        const reviewId = event.params.reviewId;

        const reviewSnap = await db.collection("reviews").doc(reviewId).get();
        if (!reviewSnap.exists) {
            logger.log("Review no encontrado:", reviewId);
            return;
        }

        const review = reviewSnap.data();
        const authorId = review.user?.userId || review.userId;
        if (!authorId) {
            logger.log("Review sin authorId:", reviewId);
            return;
        }

        const likerId = event.params.likeId;
        logger.log("Like recibido — reviewId:", reviewId, "authorId:", authorId, "likerId:", likerId);

        if (likerId === authorId) {
            logger.log("El autor se dio like a sí mismo, ignorando.");
            return;
        }

        const [authorSnap, likerSnap] = await Promise.all([
            db.collection("users").doc(authorId).get(),
            db.collection("users").doc(likerId).get(),
        ]);

        if (!authorSnap.exists) {
            logger.log("Autor no encontrado en users:", authorId);
            return;
        }

        const authorData = authorSnap.data();
        logger.log("Campos del autor:", Object.keys(authorData));

        const fcmToken = authorData?.fcmtoken;
        if (!fcmToken) {
            logger.log("Usuario sin fcmToken:", authorId);
            return;
        }

        const likerUsername = likerSnap.data()?.username || "Alguien";
        const professorName = review.professor?.name || "un profesor";

        try {
            await admin.messaging().send({
                token: fcmToken,
                notification: {
                    title: "¡Le dieron like a tu reseña!",
                    body: `${likerUsername} le dio like a tu reseña de ${professorName}`,
                },
                data: { reviewId, type: "like" },
            });
            logger.log("Notificación enviada a:", authorId);
        } catch (error) {
            logger.error("Error al enviar notificación:", error);
        }
    }
);