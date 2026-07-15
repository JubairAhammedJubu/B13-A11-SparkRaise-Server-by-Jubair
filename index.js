const express = require('express');
const cors = require('cors');
const app = express()
const port = process.env.PORT || 8000
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');

app.use(cors(
    /* {
        origin: [process.env.CLIENT_URL, 'https://crowdfunding.vercel.app'],
        credentials: true
    } */
))
app.use(express.json())


app.get('/', (req, res) => {
    res.send('Welcome to the Crowdfunding Platform Server!')
})

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

client.connect(() => {
    console.log('connecting to Mongo db');
}).catch(console.dir)

// MongoDB Collections
const db = client.db("crowdfunding");
const campaignsCollection = db.collection("campaigns");
const usersCollection = db.collection("user");
const contributionsCollection = db.collection("contributions");
const paymentsCollection = db.collection("payments");
const withdrawalsCollection = db.collection("withdrawals");
const notificationsCollection = db.collection("notifications");
const reportsCollection = db.collection("reports");
const sessionCollection = db.collection("session");

// ---- Role middleware ----
const verifyCreator = (req, res, next) => {
    if (req.user?.role !== 'creator') return res.status(403).send({ message: 'forbidden' });
    next();
}

const verifySupporter = (req, res, next) => {
    if (req.user?.role !== 'supporter') return res.status(403).send({ message: 'forbidden' });
    next();
}

const verifyAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).send({ message: 'forbidden' });
    next();
}

// session-based token verification middleware
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader) return res.status(401).send({ message: 'unauthorized access' });

    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).send({ message: 'unauthorized access' });

    const session = await sessionCollection.findOne({ token });
    if (!session) return res.status(401).send({ message: 'unauthorized access' });

    const user = await usersCollection.findOne({ _id: session.userId });
    if (!user) return res.status(401).send({ message: 'unauthorized access' });

    req.user = user;
    next();
}

// ---- Notification helper ----
// Creates a notification doc. Matches the exact shape required by the doc:
// { message, toEmail, actionRoute, time }
const notify = async (message, toEmail, actionRoute) => {
    try {
        await notificationsCollection.insertOne({
            message,
            toEmail,
            actionRoute,
            time: new Date(),
            read: false,
        });
    } catch (err) {
        console.error('Notification insert failed:', err.message);
    }
}


/* ===========================================================
   CAMPAIGNS
   =========================================================== */

// 1. GET campaigns — search, filter (category/status/deadline), sort, pagination
app.get('/api/campaigns', async (req, res) => {
    const query = {};
    if (req.query.creatorEmail) query.creator_email = req.query.creatorEmail;
    if (req.query.status) query.status = req.query.status;
    if (req.query.category) query.category = req.query.category;
    if (req.query.search) query.campaign_title = { $regex: req.query.search, $options: 'i' };

    // "Explore Campaigns" (Supporter view): only approved + deadline not passed
    if (req.query.activeOnly === 'true') {
        query.status = 'approved';
        query.deadline = { $gte: new Date().toISOString() };
    }

    let sortObj = { createdAt: -1 };
    if (req.query.sort === 'goal_asc') sortObj = { funding_goal: 1 };
    if (req.query.sort === 'goal_desc') sortObj = { funding_goal: -1 };
    if (req.query.sort === 'deadline') sortObj = { deadline: 1 };
    if (req.query.sort === 'deadline_desc') sortObj = { deadline: -1 };

    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 9;
    const skip = (page - 1) * perPage;

    const total = await campaignsCollection.countDocuments(query);
    const campaigns = await campaignsCollection.find(query).sort(sortObj).skip(skip).limit(perPage).toArray();
    res.send({ total, campaigns });
});

// 2. GET top funded campaigns (Home page) — top 6 approved by amount_raised
app.get('/api/campaigns/top-funded', async (req, res) => {
    try {
        const campaigns = await campaignsCollection
            .find({ status: 'approved' })
            .sort({ amount_raised: -1 })
            .limit(6)
            .toArray();
        res.send(campaigns);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 3. GET single campaign
app.get('/api/campaigns/:id', async (req, res) => {
    const result = await campaignsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
});



console.log("Pinged your deployment. You successfully connected to MongoDB!");

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

module.exports = app;
