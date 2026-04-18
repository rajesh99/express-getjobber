'use strict';

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// API Configuration
const API_CONFIG = {
  baseUrl: 'https://api.getjobber.com',
  endpoints: {
    authorize: '/api/oauth/authorize',
    token: '/api/oauth/token',
    graphql: '/api/graphql'
  }
};

// Store tokens in memory (in production, use a proper storage solution)
let storedTokens = null;
let quoteNoteInputFieldName = null;
let quoteNoteDisabled = false;

const port = 3000;
const callbackUrl = 'http://localhost:3000/callback';

// Initialize Express app
const app = express();

function parseTokenScopes(accessToken) {
  try {
    const [, payload] = accessToken.split('.');
    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof decodedPayload.scope === 'string' ? decodedPayload.scope.split(' ') : [];
  } catch (error) {
    console.error('Failed to decode access token scopes:', error.message);
    return [];
  }
}

function buildScopeWarnings(scopes) {
  const warnings = [];

  if (!scopes.some((scope) => scope.includes('quote'))) {
    warnings.push('The current access token does not appear to include quote scopes. You may need to enable quote permissions in the Jobber app and re-authorize.');
  }

  return warnings;
}

function pickRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getClientPropertyId(client) {
  if (!client || !client.properties) {
    return null;
  }

  if (Array.isArray(client.properties) && client.properties.length) {
    return client.properties[0].id || null;
  }

  if (Array.isArray(client.properties.nodes) && client.properties.nodes.length) {
    return client.properties.nodes[0].id || null;
  }

  return client.properties.id || null;
}

function buildDefaultQuoteLineItems() {
  return [
    {
      name: 'Estimate',
      quantity: 1,
      unitPrice: 0,
      saveToProductsAndServices: false
    }
  ];
}

function normalizeTemplateLineItems(quoteTemplates) {
  const usableQuote = quoteTemplates.find((quote) => {
    const items = quote && quote.lineItems && Array.isArray(quote.lineItems.nodes) ? quote.lineItems.nodes : [];
    return items.length > 0;
  });

  if (!usableQuote) {
    return null;
  }

  const normalizedLineItems = usableQuote.lineItems.nodes
    .map((lineItem) => ({
      name: lineItem.name || 'Estimate',
      description: lineItem.description || '',
      quantity: Number.isFinite(Number(lineItem.quantity)) ? Number(lineItem.quantity) : 1,
      unitPrice: Number.isFinite(Number(lineItem.unitPrice)) ? Number(lineItem.unitPrice) : 0,
      saveToProductsAndServices: false
    }))
    .filter((lineItem) => lineItem.name);

  return normalizedLineItems.length ? normalizedLineItems : null;
}

async function graphqlRequest(query, variables) {
  const response = await fetch(`${API_CONFIG.baseUrl}${API_CONFIG.endpoints.graphql}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Authorization': `Bearer ${storedTokens.access_token}`,
      'X-JOBBER-GRAPHQL-VERSION': '2025-01-20'
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch (error) {
    throw {
      stage: 'graphql',
      status: response.status,
      message: 'Failed to parse API response',
      details: responseText
    };
  }

  if (response.status === 401) {
    throw {
      stage: 'graphql',
      status: response.status,
      message: 'Authentication failed',
      details: 'The access token may be invalid or expired. Please try re-authenticating.'
    };
  }

  if (data.errors) {
    throw {
      stage: 'graphql',
      status: response.status,
      message: 'GraphQL request failed',
      details: data.errors
    };
  }

  return data.data;
}

async function fetchClients() {
  const query = `
    query FetchClients {
      clients {
        totalCount
        nodes {
          id
          firstName
          lastName
          properties {
            id
          }
          billingAddress {
            city
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(query);
  return data.clients;
}

async function fetchQuoteTemplates() {
  const query = `
    query FetchQuoteTemplates {
      quotes {
        nodes {
          id
          lineItems {
            nodes {
              name
              description
              quantity
              unitPrice
            }
          }
        }
      }
    }
  `;

  try {
    const data = await graphqlRequest(query);
    return data.quotes && Array.isArray(data.quotes.nodes) ? data.quotes.nodes.slice(0, 3) : [];
  } catch (error) {
    console.error('Failed to fetch quote templates, falling back to default line items:', error);
    return [];
  }
}

async function createQuoteForClient(client, quoteTemplates) {
  const mutation = `
    mutation CreateQuote($attributes: QuoteCreateAttributes!) {
      quoteCreate(attributes: $attributes) {
        quote {
          id
        }
      }
    }
  `;

  const propertyId = getClientPropertyId(client);
  const lineItems = normalizeTemplateLineItems(quoteTemplates) || buildDefaultQuoteLineItems();

  if (!propertyId) {
    throw {
      stage: 'quoteCreate',
      status: 400,
      message: 'Selected client has no property available for quote creation.',
      details: { clientId: client.id }
    };
  }

  const data = await graphqlRequest(mutation, {
    attributes: {
      clientId: client.id,
      propertyId,
      lineItems
    }
  });

  return data.quoteCreate.quote;
}

async function addQuoteTextLineItem(quoteId, client) {
  const mutation = `
    mutation AddQuoteTextLineItems($quoteId: EncodedId!, $lineItems: [QuoteCreateTextLineItemAttributes!]!) {
      quoteCreateTextLineItems(quoteId: $quoteId, lineItems: $lineItems) {
        quote {
          id
        }
      }
    }
  `;

  return graphqlRequest(mutation, {
    quoteId,
    lineItems: [
      {
        name: 'Initial estimate line',
        description: `Generated automatically for ${client.firstName || 'client'} ${client.lastName || ''}`.trim()
      }
    ]
  });
}

async function addQuoteNote(quoteId, client) {
  if (quoteNoteDisabled) {
    return {
      skipped: true,
      reason: 'quoteCreateNote input fields are not supported in this schema version for the configured payload.'
    };
  }

  const noteText = `Estimate generated automatically for ${client.firstName || 'client'} ${client.lastName || ''}`.trim();
  const candidateFields = quoteNoteInputFieldName
    ? [quoteNoteInputFieldName]
    : ['body', 'content', 'message', 'text', 'description', 'note'];

  const mutation = `
    mutation AddQuoteNote($quoteId: EncodedId!, $input: QuoteCreateNoteInput!) {
      quoteCreateNote(quoteId: $quoteId, input: $input) {
        quote {
          id
        }
      }
    }
  `;

  let lastError = null;

  for (const fieldName of candidateFields) {
    try {
      const response = await graphqlRequest(mutation, {
        quoteId,
        input: {
          [fieldName]: noteText
        }
      });

      quoteNoteInputFieldName = fieldName;
      return response;
    } catch (error) {
      lastError = error;
      const hasUndefinedFieldError = Array.isArray(error.details)
        && error.details.some((detail) => typeof detail.message === 'string' && detail.message.includes('Field is not defined on QuoteCreateNoteInput'));

      if (!hasUndefinedFieldError) {
        throw error;
      }
    }
  }

  quoteNoteDisabled = true;
  throw lastError || {
    stage: 'quoteCreateNote',
    status: 400,
    message: 'Could not find a supported field on QuoteCreateNoteInput.',
    details: { triedFields: candidateFields }
  };
}

// Initial page redirecting to GetJobber
app.get('/auth', (req, res) => {
  const authUrl = new URL(API_CONFIG.endpoints.authorize, API_CONFIG.baseUrl);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', process.env.CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', callbackUrl);
  authUrl.searchParams.append('scope', 'notifications');
  authUrl.searchParams.append('state', '3(#0/!~');

  console.log('Authorization URL:', authUrl.toString());
  res.redirect(authUrl.toString());
});

// Callback service parsing the authorization token and asking for the access token
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  try {
    const tokenResponse = await fetch(`${API_CONFIG.baseUrl}${API_CONFIG.endpoints.token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: callbackUrl,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET
      })
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Token Error Response:', errorData);
      throw new Error(`Token request failed with status ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();

    // Store the tokens - only include properties that exist in the response
    storedTokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token
    };

    console.log('Access Token:', storedTokens.access_token);
    console.log('Refresh Token:', storedTokens.refresh_token);

    return res.status(200).json(storedTokens);
  } catch (error) {
    console.error('Access Token Error:', error.message);
    return res.status(500).json('Authentication failed');
  }
});

// Fetch clients, pick one at random, and attempt to create a quote.
app.get('/clients', async (req, res) => {
  if (!storedTokens || !storedTokens.access_token) {
    return res.status(401).json({ error: 'Not authenticated. Please login first.' });
  }

  try {
    const scopes = parseTokenScopes(storedTokens.access_token);
    const warnings = buildScopeWarnings(scopes);
    const clients = await fetchClients();
    const quoteTemplates = await fetchQuoteTemplates();
    const clientsWithProperties = clients.nodes.filter((client) => Boolean(getClientPropertyId(client)));

    if (!clients.nodes.length) {
      return res.status(404).json({ error: 'No clients were returned by the API.' });
    }

    if (!clientsWithProperties.length) {
      return res.status(404).json({ error: 'No clients with properties were returned by the API.' });
    }

    const selectedClient = pickRandomItem(clientsWithProperties);
    const quote = await createQuoteForClient(selectedClient, quoteTemplates);
    const followUpResults = {};

    console.log('Quote created successfully.');
    console.log('Clients with properties available:', clientsWithProperties.length);
    console.log('Quote templates fetched:', quoteTemplates.length);
    console.log('Selected client:', {
      id: selectedClient.id,
      firstName: selectedClient.firstName,
      lastName: selectedClient.lastName,
      propertyId: getClientPropertyId(selectedClient),
      city: selectedClient.billingAddress ? selectedClient.billingAddress.city : null
    });
    console.log('Created quote:', quote);

    try {
      followUpResults.textLineItem = await addQuoteTextLineItem(quote.id, selectedClient);
      console.log('Quote text line item created successfully for quote:', quote.id);
      console.log('Quote text line item response:', followUpResults.textLineItem);
    } catch (error) {
      followUpResults.textLineItemError = error;
      console.error('Failed to create quote text line item for quote:', quote.id, error);
    }

    try {
      followUpResults.note = await addQuoteNote(quote.id, selectedClient);
      console.log('Quote note created successfully for quote:', quote.id);
      console.log('Quote note response:', followUpResults.note);
    } catch (error) {
      followUpResults.noteError = error;
      console.error('Failed to create quote note for quote:', quote.id, error);
    }

    return res.status(200).json({
      totalClients: clients.totalCount,
      totalClientsWithProperties: clientsWithProperties.length,
      selectedClient,
      quote,
      quoteTemplatesCount: quoteTemplates.length,
      followUpResults,
      warnings,
      scopes
    });
  } catch (error) {
    console.error('Error handling /clients:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Failed to create quote for a random client',
      details: error.details || error,
      stage: error.stage || 'clients'
    });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <h1>GetJobber OAuth Demo</h1>
    <p><a href="/auth">Log in with GetJobber</a></p>
    ${storedTokens ? `<p><a href="/clients">Create Quote For Random Client</a></p>` : ''}
  `);
});

// Start the server
app.listen(port, (err) => {
  if (err) return console.error(err);
  console.log(`Express server listening at http://localhost:${port}`);
});
