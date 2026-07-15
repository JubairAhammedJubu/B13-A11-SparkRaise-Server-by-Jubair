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

// 4. POST new campaign (creator) — saved as "pending", visible after admin approval
app.post('/api/campaigns', verifyToken, verifyCreator, async (req, res) => {
    try {
        const campaign = req.body;
        const newCampaign = {
            ...campaign,
            creator_email: req.user.email,
            creator_name: req.user.name,
            amount_raised: 0,
            status: 'pending',
            createdAt: new Date()
        };
        const result = await campaignsCollection.insertOne(newCampaign);
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 5. PATCH update campaign (creator) — per doc, only title/story/reward_info are editable
app.patch('/api/campaigns/:id', verifyToken, verifyCreator, async (req, res) => {
    try {
        const { campaign_title, campaign_story, reward_info } = req.body;
        const updates = { updatedAt: new Date() };
        if (campaign_title !== undefined) updates.campaign_title = campaign_title;
        if (campaign_story !== undefined) updates.campaign_story = campaign_story;
        if (reward_info !== undefined) updates.reward_info = reward_info;

        const result = await campaignsCollection.updateOne(
            { _id: new ObjectId(req.params.id), creator_email: req.user.email },
            { $set: updates }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 6. DELETE campaign (creator) — refunds all approved supporters' contribution credits
app.delete('/api/campaigns/:id', verifyToken, verifyCreator, async (req, res) => {
    try {
        const campaignId = req.params.id;
        const campaign = await campaignsCollection.findOne({ _id: new ObjectId(campaignId), creator_email: req.user.email });
        if (!campaign) return res.status(404).send({ message: 'Campaign not found' });

        const approvedContributions = await contributionsCollection.find({
            campaign_id: campaignId,
            status: 'approved'
        }).toArray();

        for (const c of approvedContributions) {
            await usersCollection.updateOne(
                { email: c.supporter_email },
                { $inc: { credits: c.Contribution_amount } }
            );
        }

        await contributionsCollection.deleteMany({ campaign_id: campaignId });
        const result = await campaignsCollection.deleteOne({ _id: new ObjectId(campaignId) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 7. PATCH campaign status (admin approve/reject)
app.patch('/api/campaigns/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { status } = req.body; // 'approved' | 'rejected'
        const campaign = await campaignsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!campaign) return res.status(404).send({ message: 'Campaign not found' });

        const result = await campaignsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status, updatedAt: new Date() } }
        );

        await notify(
            `Your campaign "${campaign.campaign_title}" was ${status} by the admin`,
            campaign.creator_email,
            '/dashboard/creator/my-campaigns'
        );

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 8. DELETE campaign (admin — Manage Campaigns)
app.delete('/api/admin/campaigns/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        await contributionsCollection.deleteMany({ campaign_id: req.params.id });
        const result = await campaignsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   CONTRIBUTIONS
   =========================================================== */

// 9. POST contribution (supporter) — deducts credits immediately, status "pending"
app.post('/api/contributions', verifyToken, verifySupporter, async (req, res) => {
    try {
        const { campaign_id, Contribution_amount, message } = req.body;

        const campaign = await campaignsCollection.findOne({ _id: new ObjectId(campaign_id) });
        if (!campaign) return res.status(404).send({ message: 'Campaign not found' });
        if (campaign.status !== 'approved') return res.status(400).send({ message: 'Campaign is not open for contributions' });
        if (Contribution_amount < campaign.minimum_Contribution) {
            return res.status(400).send({ message: `Minimum contribution is ${campaign.minimum_Contribution} credits` });
        }
        if ((req.user.credits || 0) < Contribution_amount) {
            return res.status(400).send({ message: 'Insufficient credits' });
        }

        const newContribution = {
            campaign_id,
            campaign_title: campaign.campaign_title,
            Contribution_amount,
            supporter_email: req.user.email,
            supporter_name: req.user.name,
            creator_name: campaign.creator_name,
            creator_email: campaign.creator_email,
            message: message || '',
            current_date: new Date(),
            status: 'pending',
        };

        const result = await contributionsCollection.insertOne(newContribution);

        // deduct credits from supporter immediately
        await usersCollection.updateOne(
            { email: req.user.email },
            { $inc: { credits: -Contribution_amount } }
        );

        await notify(
            `${req.user.name} contributed ${Contribution_amount} credits to ${campaign.campaign_title}`,
            campaign.creator_email,
            '/dashboard/creator'
        );

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 10. GET contributions — filterable by supporter, creator, campaign, status
app.get('/api/contributions', verifyToken, async (req, res) => {
    try {
        const query = {};
        if (req.query.supporterEmail) query.supporter_email = req.query.supporterEmail;
        if (req.query.creatorEmail) query.creator_email = req.query.creatorEmail;
        if (req.query.campaignId) query.campaign_id = req.query.campaignId;
        if (req.query.status) query.status = req.query.status;

        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 10;
        const skip = (page - 1) * perPage;

        const total = await contributionsCollection.countDocuments(query);
        const contributions = await contributionsCollection.find(query).sort({ current_date: -1 }).skip(skip).limit(perPage).toArray();
        res.send({ total, contributions });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});




console.log("Pinged your deployment. You successfully connected to MongoDB!");

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

module.exports = app;
