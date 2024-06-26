const dotenv = require('dotenv').config();
const ini = require('ini');
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const url = require('url');
const pg = require('pg');
const pgSession = require('connect-pg-simple')(session);
const format = require('pg-format');
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');
const http = require('http');
const https = require('https');
const { type } = require('os');
const { isNumberObject } = require('util/types');
const { log } = require('console');

const app = express();

app.use(express.static(path.join(__dirname, 'assets'))); // Установка статического каталога для файлов HTML
app.use(cookieParser());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const pool = new pg.Pool({
  user: process.env.DB_USER,
  host: 'dmark.com.ua',
  database: 'dm',
  password: process.env.DB_PASSWORD,
  port: 5432,
});


// Middleware для обработки данных из тела запроса
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: new pgSession({
      pool: pool,
      // Некоторые дополнительные параметры хранилища, если необходимо
      // Например, ttl: 3600 // Время жизни сеанса в секундах (1 час)
    }),
  })
);

const config_ini = ini.parse(fs.readFileSync('exchange.ini', 'utf-8'));
let euro_coefficient = parseFloat(config_ini.EURO_COEFFICIENT).toFixed(2);

app.get('/favicon.ico', (req, res) => {
  const faviconPath = path.join(__dirname, 'assets', 'img', 'favicon.ico');
  res.sendFile(faviconPath);
});

app.get('/', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  if (req.query.search) {
    const parsedUrl = url.parse(req.url, true);
    const queryParameters = parsedUrl.query;
    const targetUrl = `/catalog/?${Object.keys(queryParameters).map(key => `${key}=${queryParameters[key]}`).join('&')}`;

    res.redirect(targetUrl);
  } else {
    // Если параметр "GET" не указан, выводим все записи
    pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END LIMIT 90`, (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      let rows = result.rows;
      rows = rows.map((row) => {
        row.pictures = JSON.parse(row.pictures);
        row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
        return row;
      });

      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('index', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows, cart: cartLength > 0 ? cartLength : null });
    });
  }
});

app.get('/registration', (req, res) => {
  if (req.session.isAuthenticated) return res.redirect('/catalog');
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');
  res.render('registration');
});

app.post('/registration', async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;

    // Хеширование пароля перед сохранением
    const hashedPassword = await bcrypt.hash(password, 10);

    // Текущая дата и время
    const currentDate = new Date().toISOString();

    // Вставка пользователя в базу данных
    pool.query(
      'INSERT INTO users (first_name, last_name, email, password, reg_date, log_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [first_name, last_name, email, hashedPassword, currentDate, currentDate],
      (err, result) => {
        if (err) {
          return res.status(500).json({ error: 'Ошибка при регистрации пользователя' });
        }

        const user = result.rows[0];

        req.session.userId = user.id;
        req.session.isAuthenticated = true;

        return res.redirect('/catalog?registration=success');
      }
    );
  } catch (error) {
    return res.status(500).json({ error: 'Что-то пошло не так' });
  }
});

app.get('/authentication', (req, res) => {
  if (req.session.isAuthenticated) return res.redirect('/account');
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');
  res.render('authentication');
});

app.post('/authentication', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Получаем пользователя по email из базы данных
    pool.query('SELECT * FROM users WHERE email = $1', [email], async (err, result) => {
      if (err || result.rows.length === 0) {
        return res.status(401).json({ error: 'Неверный email или пароль' });
      }

      const user = result.rows[0];

      // Проверяем совпадение хешированного пароля
      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Неверный email или пароль' });
      }

      // Обновляем дату последней авторизации (log_date)
      const currentDate = new Date().toISOString();
      pool.query('UPDATE users SET log_date = $1 WHERE id = $2', [currentDate, user.id], (err, result) => {
        if (err) {
          return res.status(500).json({ error: 'Ошибка при обновлении даты авторизации' });
        }
      });

      req.session.userId = user.id;
      req.session.isAuthenticated = true;

      return res.redirect('/catalog?authentication=success');
    });
  } catch (error) {
    return res.status(500).json({ error: 'Что-то пошло не так' });
  }
});

app.get('/account', async (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  if (req.session.isAuthenticated) {
    try {
      const isAdmin = await checkAdminUser(req.session.userId);

      if (isAdmin) {
        res.render('account', { user: (req.session.isAuthenticated) ? true : false, euro: euro_coefficient, url: req.originalUrl });
      } else {
        res.send('Добро пожаловать на защищенную страницу!');
      }
    } catch (error) {
      res.status(500).send('Произошла ошибка при проверке прав администратора');
    }
  } else {
    res.redirect('/authentication'); // If the user is not authenticated, redirect them to the login page
  }
});

app.get('/logout', (req, res) => {
  // Удаление данных сессии, связанных с авторизацией
  req.session.destroy((err) => {
    if (err) {
      console.log(err);
    }
    res.redirect('/catalog');
  });
});

app.post('/account/euro', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  var { euro } = req.body;
  euro_coefficient = parseFloat(euro).toFixed(2);

  config_ini.EURO_COEFFICIENT = euro_coefficient;
  fs.writeFileSync('exchange.ini', ini.stringify(config_ini), 'utf-8');

  res.redirect('/account');
});

app.get('/account/favorites', (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  pool.query(`SELECT products.*, CEIL((products.price / 100) * (100 + products.price_factor) * 100) / 100 AS price_total FROM favorites INNER JOIN products ON favorites.product = products.id WHERE favorites.user = $1`, [req.session.userId], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    let rows = result.rows;
    rows = rows.map((row) => {
      row.pictures = JSON.parse(row.pictures);
      row.price_total = (parseFloat(row.price_total).toFixed(2)).replace('.', ',');
      return row;
    });

    res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows, cart: req.cookies.cart ? (JSON.parse(req.cookies.cart)).items : null });
  });
});

app.get('/account/review/add', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(400);

  var grade = req.query.grade;

  // Проверка, что значение grade находится в диапазоне от 1 до 5
  if (grade < 1 || grade > 5) {
    return res.status(400);
  }

  try {
    const existingReviewResult = await pool.query(`SELECT * FROM reviews WHERE "user" = $1`, [req.session.userId]);
    const existingReview = existingReviewResult.rows[0];

    if (existingReview) {
      await pool.query(`UPDATE reviews SET grade = $1 WHERE "user" = $2`, [grade, req.session.userId]);
      res.status(201).json({ message: 'SUCCESS' });
    } else {
      await pool.query(`INSERT INTO reviews ("user", grade) VALUES ($1, $2)`, [req.session.userId, grade]);
      res.status(201).json({ message: 'SUCCESS' });
    }
  } catch (error) {
    console.error('Ошибка при добавлении/обновлении отзыва:', error);
    res.status(500);
  }
});

app.get('/account/favorites/add', (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');

  pool.query(`SELECT COUNT(*) as count FROM favorites WHERE "user" = $1 AND product = $2`, [req.session.userId, req.query.id], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    const rowCount = result.rows[0].count;

    if (rowCount > 0) {
      return res.status(400).send('duplicate');
    }

    pool.query(`INSERT INTO favorites ("user", product) VALUES ($1, $2)`, [req.session.userId, req.query.id], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      res.redirect('/account/favorites');
    });
  });
});

app.get('/account/favorites/del', (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');

  pool.query(`DELETE FROM favorites WHERE "user" = $1 AND product = $2`, [req.session.userId, req.query.id], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    res.redirect('/account/favorites');
  });
});

app.get('/info/terms', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  if (req.cookies.cart) {
    cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
  } else {
    cartLength = 0;
  }

  res.render('terms', { user: (req.session.isAuthenticated) ? true : false, url: req.path, cart: cartLength > 0 ? cartLength : null });
});

app.get('/info/privacy/', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  if (req.cookies.cart) {
    cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
  } else {
    cartLength = 0;
  }

  res.render('privacy', { user: (req.session.isAuthenticated) ? true : false, url: req.path, cart: cartLength > 0 ? cartLength : null });
});

app.get('/cart', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  if (req.query.search) return res.redirect(`/catalog?${Object.keys(req.query).map(key => `${key}=${req.query[key]}`).join('&')}`);

  if (req.cookies.cart) {
    const cart = JSON.parse(req.cookies.cart);
    const cart_items = cart.items;

    if (Object.keys(cart_items).length > 0) {
      const itemIds = Object.keys(cart_items);

      const placeholders = format('(%L)', itemIds);  // Форматируем массив itemIds в строку, чтобы использовать в запросе

      pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE id IN ${placeholders}`, (err, result) => {
        if (err) {
          console.error(err);
          res.clearCookie('cart');
          return res.status(500).send('Internal Server Error');
        }

        let rows = result.rows;
        rows = rows.map((row) => {
          row.pictures = JSON.parse(row.pictures);
          row.price_total = (parseFloat(row.price_total).toFixed(2)).replace('.', ',');
          row.quantity = cart_items[row.id]; // Добавляем количество товара из корзины в результат
          return row;
        });

        res.render('cart', { user: (req.session.isAuthenticated) ? true : false, euro: euro_coefficient, url: req.originalUrl, cart: rows });
      });
    } else {
      res.render('cart', { user: (req.session.isAuthenticated) ? true : false, euro: euro_coefficient, url: req.originalUrl, cart: [] });
    }
  } else {
    res.render('cart', { user: (req.session.isAuthenticated) ? true : false, euro: euro_coefficient, url: req.originalUrl, cart: [] });
  }
});

app.post('/cart', express.urlencoded({ extended: false }), (req, res) => {
  if (!req.body) return res.sendStatus(400);

  const { first_name, last_name, phone_number, products, amount, region, address, comment } = req.body;
  const data = [];
  console.log(products + '\n' + amount);
  console.log(typeof products);

  if (typeof products === 'string') {
    const product = {
      id: products,
      amount: amount
    };
    data.push(product);
  } else {
    for (let i = 0; i < products.length; i++) {
      const product = {
        id: products[i],
        amount: amount[i]
      };
      data.push(product);
    }
  }

  const jsonData = JSON.stringify(data);

  pool.query(`INSERT INTO orders ("user", first_name, last_name, phone_number, products, region, address, comment, status, date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [req.session.isAuthenticated ? req.session.userId : null, first_name, last_name, phone_number.replace(/[^\w]/gi, ''), jsonData, region, address, comment || null, '0', (new Date())], async (err, result) => {
    if (err) {
      console.error(req.body);
      console.error(err);
      res.sendStatus(500);
    } else {
      res.clearCookie('cart');
      res.redirect('/catalog?order=success');

      const order_id = result.rows[0].id;

      try {
        const response = await axios.post(
          `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `Надійшло нове замовлення №${order_id}\nhttps://dm.lviv.ua/account/orders/`,
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      } catch (error) {
        console.error('Ошибка при отправке уведомления в Telegram:', error);
      }
    }
  });
});

app.get('/cart/data', async (req, res) => {
  if (req.query.region) {
    try {
      const response = await axios.post('https://api.novaposhta.ua/v2.0/json/', {
        modelName: 'Address',
        calledMethod: 'getCities',
        methodProperties: {},
        apiKey: '64c8642d4bde514f871f7c14ba4c33ef'
      });

      if (response.data.success) {
        data = response.data.data.map(city => city.Description);

        // Фильтрация городов по заданному тексту
        const searchText = req.query.region;
        const regex = new RegExp('^' + searchText.toLowerCase());
        cities = data.filter(city => city.toLowerCase().match(regex));

        // Результаты фильтрации
        res.send(cities)
      }
      else {
        throw new Error('Ошибка при получении списка городов');
      }
    }
    catch (error) {
      console.error('Произошла ошибка:', error.message);
      res.status(500).send('Произошла ошибка');
    }
  }
  else if (req.query.branch && req.query.type) {
    try {
      const response = await axios.post('https://api.novaposhta.ua/v2.0/json/', {
        modelName: 'Address',
        calledMethod: 'getWarehouses',
        methodProperties: {
          CityName: req.query.branch,
          Language: 'ua',
        },
        apiKey: '64c8642d4bde514f871f7c14ba4c33ef'
      });

      if (response.data.success) {
        const warehouses = response.data.data;

        var filteredWarehouses;

        if (req.query.type == 'Відділення') {
          filteredWarehouses = warehouses.filter(warehouse => warehouse.Description.startsWith('Відділення'));
        }
        else {
          filteredWarehouses = warehouses.filter(warehouse => warehouse.Description.startsWith('Поштомат'));
        }

        const descriptions = filteredWarehouses.map(warehouse => warehouse.Description);

        // Отправка списка описаний отделений
        res.send(descriptions);
      } else {
        throw new Error('Ошибка при получении списка отделений');
      }
    } catch (error) {
      console.error('Произошла ошибка:', error.message);
      res.status(500).send('Произошла ошибка');
    }
  }

});

app.get('/cart/add', (req, res) => {
  const itemId = req.query.id; // Получаем идентификатор товара из запроса


  if (req.cookies.cart) {  // Проверяем, есть ли уже корзина в cookie  
    const cart = JSON.parse(req.cookies.cart);  // Если корзина уже существует, добавляем товар в нее (если его там еще нет)

    if (cart.items[itemId]) {
      if (req.query.quantity) {
        cart.items[itemId] += Number(req.query.quantity);
        res.cookie('cart', JSON.stringify(cart));  // Обновляем cookie с обновленной корзиной
        return res.status(200).send('DUPLICATE');
      } else {
        cart.items[itemId] += 1;  // Если товар уже есть в корзине, увеличиваем количество на 1
        res.cookie('cart', JSON.stringify(cart));
        return res.status(200).send('DUPLICATE');
      }
    } else {
      cart.items[itemId] = 1;  // Если товара с таким идентификатором ещё нет в корзине, добавляем его с количеством 1
    }

    res.cookie('cart', JSON.stringify(cart));
    res.json({ message: 'Товар добавлен в корзину' });
  } else {
    // Если корзина не существует, создаем новую корзину и добавляем товар в нее с количеством 1
    const cart = {
      items: {
        [itemId]: 1
      }
    };
    res.cookie('cart', JSON.stringify(cart));
    res.json({ message: 'Товар добавлен в корзину' });
  }
});

app.get('/cart/del', (req, res) => {
  const itemId = req.query.id; // Получаем идентификатор товара из запроса

  // Проверяем, есть ли корзина в cookie
  if (req.cookies.cart) {
    const cart = JSON.parse(req.cookies.cart);

    if (req.query.quantity) {
      cart.items[itemId] -= Number(req.query.quantity);
      res.cookie('cart', JSON.stringify(cart));  // Обновляем cookie с обновленной корзиной
      return res.status(200).send('OK');
    } else {
      delete cart.items[itemId];  // Удаляем товар из корзины
      res.cookie('cart', JSON.stringify(cart));  // Обновляем cookie с обновленной корзиной
      return res.redirect('/cart'); // Перенаправляем на страницу корзины
    }
  }
});

app.get('/account/orders', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');
  if (!req.originalUrl.endsWith('/') && !req.query.page) return res.redirect(req.originalUrl + '/');

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Произошла ошибка при проверке прав администратора');
  }

  try {
    var orders = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 20');

    if (parseInt(req.query.page)) orders = await pool.query(`SELECT * FROM orders ORDER BY id DESC LIMIT 20 OFFSET $1`, [req.query.page * 20 - 20]);

    let rows = orders.rows;
    rows = rows.map((row) => {
      if (row.date) {
        row.date = new Date(row.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }) + " (" + new Date(row.date).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) + ")";
        return row;
      }
    });

    const allOrders = [];

    for (const order of orders.rows) {
      const products = order.products;
      const orderProducts = [];

      for (const product of products) {
        const { id, amount } = product;
        const itemRow = await pool.query(
          'SELECT id, brand_original, title_original, pictures, volume, price, price_factor, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE id = $1',
          [id]
        );

        if (itemRow.rows.length > 0) {
          const itemData = itemRow.rows[0];
          const productData = {
            id,
            amount,
            brand_original: itemData.brand_original,
            title_original: itemData.title_original,
            pictures: JSON.parse(itemData.pictures),
            volume: itemData.volume,
            price: (parseFloat(itemData.price_total)).toFixed(2).replace('.', ',')
          };
          orderProducts.push(productData);
        }
      }

      const fullOrder = {
        ...order,
        products: orderProducts
      };

      allOrders.push(fullOrder);
    }

    res.render('orders.ejs', { user: req.session.isAuthenticated, euro: euro_coefficient, url: req.originalUrl, orders: allOrders, page: parseInt(req.query.page) ? parseInt(req.query.page) : 1 });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get('/account/orders/:id', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Произошла ошибка при проверке прав администратора');
  }

  try {
    const orders = await pool.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [req.params.id]);

    let rows = orders.rows;
    rows = rows.map((row) => {
      if (row.date) {
        row.date = new Date(row.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }) + " (" + new Date(row.date).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) + ")";
        return row;
      }
    });

    const allOrders = [];

    for (const order of orders.rows) {
      const products = order.products;
      const orderProducts = [];

      for (const product of products) {
        const { id, amount } = product;
        const itemRow = await pool.query(
          'SELECT id, brand_original, title_original, pictures, volume, price, price_factor, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE id = $1',
          [id]
        );

        if (itemRow.rows.length > 0) {
          const itemData = itemRow.rows[0];
          const productData = {
            id,
            amount,
            brand_original: itemData.brand_original,
            title_original: itemData.title_original,
            pictures: JSON.parse(itemData.pictures),
            volume: itemData.volume,
            price: (parseFloat(itemData.price_total)).toFixed(2).replace('.', ',')
          };
          orderProducts.push(productData);
        }
      }

      const fullOrder = {
        ...order,
        products: orderProducts
      };

      allOrders.push(fullOrder);
    }

    res.render('order.ejs', { user: req.session.isAuthenticated, euro: euro_coefficient, url: req.originalUrl, orders: allOrders });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.post('/account/orders/:id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!req.body) return res.sendStatus(400);

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  const { products, amount } = req.body;
  const data = [];

  for (let i = 0; i < products.length; i++) {
    const product = {
      id: products[i],
      amount: amount[i]
    };
    data.push(product);
  }

  const jsonData = JSON.stringify(data);

  pool.query(`UPDATE orders SET products = $1 WHERE id = $2`, [jsonData, req.params.id], (err) => {
    if (err) {
      console.error(req.body);
      console.error(err);
      res.sendStatus(500);
    } else {
      res.redirect('/account/orders/' + req.params.id);
    }
  });
});

app.post('/account/orders/:id/status', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(500);

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  var { status } = req.body;

  try {
    if (status) {
      await pool.query(`UPDATE orders SET status = $1 WHERE id = $2`, [status, req.params.id]);
    }

    res.redirect('/account/orders');
  } catch (err) {
    console.error('Internal Server Error', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/account/orders/:id/pdf', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  try {
    const orderRow = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);

    if (orderRow.rows.length === 0) {
      return res.status(404).send('Заказ не найден');
    }

    let rows = orderRow.rows;
    rows = rows.map((row) => {
      if (row.date) {
        row.date = new Date(row.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
        return row;
      }
    });

    const order = orderRow.rows[0];

    const products = order.products;
    const orderProducts = [];

    for (const product of products) {
      const { id, amount } = product;
      const itemRow = await pool.query(
        'SELECT id, brand_translation, title_translation, brand_original, title_original, volume, price, price_factor, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE id = $1',
        [id]
      );

      if (itemRow.rows.length > 0) {
        const itemData = itemRow.rows[0];
        const productData = {
          id,
          amount,
          brand_original: itemData.brand_original,
          title_original: itemData.title_original,
          brand_translation: itemData.brand_translation,
          title_translation: itemData.title_translation,
          volume: itemData.volume,
          price: ((parseFloat(itemData.price_total) * euro_coefficient).toFixed(2)).replace('.', ','),
        };
        orderProducts.push(productData);
      }
    }

    const fullOrder = {
      ...order,
      products: orderProducts
    };

    res.render('invoice.ejs', { order: fullOrder });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get('/account/editor', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/authentication');
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  if (req.query.search) {
    const filter = `%${req.query.search.toLowerCase().replace('/', '')}%`;

    pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE LOWER(title_original) LIKE $1 OR LOWER(title_translation) LIKE $2`, [filter, filter], (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      let rows = result.rows;
      rows = rows.map((row) => {
        row.pictures = JSON.parse(row.pictures);
        row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
        return row;
      });

      res.render('editor', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows });
    });

  } else {
    pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products`, (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      let rows = result.rows;
      rows = rows.map((row) => {
        row.pictures = JSON.parse(row.pictures);
        row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
        return row;
      });

      res.render('editor', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows });
    });
  }
});

app.post('/account/editor/save', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(500);

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  var { id, price, price_factor, amount, box, pictures, description, exists, visibility } = req.body;

  try {
    if (!id) {
      return res.status(400);
    }

    if (price && price_factor) {
      await pool.query(`UPDATE products SET price = $1, price_factor = $2 WHERE id = $3`, [parseFloat((price).replace(',', '.')).toFixed(2), price_factor, id]);
    } if (amount) {
      await pool.query(`UPDATE products SET exists = $1, amount = $2 WHERE id = $3`, [exists, amount, id]);
    } if (box) {
      await pool.query(`UPDATE products SET "case" = $1 WHERE id = $2`, [box, id]);
    } if (description) {
      await pool.query(`UPDATE products SET description = $1 WHERE id = $2`, [description, id]);
    } if (visibility) {
      await pool.query(`UPDATE products SET visibility = $1 WHERE id = $2`, [visibility, id]);
    } if (pictures) {
      const resultArray = pictures.split(',https');
      for (let i = 1; i < resultArray.length; i++) {
        resultArray[i] = 'https' + resultArray[i];
      }
      pictures = JSON.stringify(resultArray);

      await pool.query(`UPDATE products SET pictures = $1 WHERE id = $2`, [pictures, id]);
    } else {
      await pool.query(`UPDATE products SET exists = $1 WHERE id = $2`, [exists, id]);
    }

    res.status(201).json({ message: 'SUCCESS' });
  } catch (err) {
    console.error('Internal Server Error', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/account/product/add', express.urlencoded({ extended: false }), async (req, res) => {
  if (!req.session.isAuthenticated) return res.sendStatus(400);
  if (!req.body) return res.sendStatus(400);

  try {
    const isAdmin = await checkAdminUser(req.session.userId);

    if (!isAdmin) {
      return res.send('У вас немає прав для доступу до цієї сторінки!');
    }
  } catch (error) {
    return res.status(500).send('Сталася помилка під час перевірки прав адміністратора.');
  }

  var { brand, title_original, title_translation, type, pictures, description, volume, weight, price, price_factor, amount, box, dm } = req.body;

  var brand_translation = null;
  if (brand === 'Denkmit') {
    brand_translation = 'Денкміт';
  } else if (brand === 'Balea') {
    brand_translation = 'Балеа';
  } else if (brand === 'Alverde') {
    brand_translation = 'Альверде';
  } else if (brand === 'Dontodent') {
    brand_translation = 'Донтодент';
  } else if (brand === 'Mivolis') {
    brand_translation = 'Міволіс';
  } else if (brand === 'Frosch') {
    brand_translation = 'Фрош';
  } else if (brand === 'Profissimo') {
    brand_translation = 'Профісімо';
  } else if (brand === 'Babylove') {
    brand_translation = 'Бейбілав';
  } else if (brand === 'Visiomax') {
    brand_translation = 'Візіомакс';
  } else if (brand === 'Deluxe') {
    brand_translation = 'Делюкс';
  } else if (brand === 'Theramed') {
    brand_translation = 'Тхерамед';
  } else {
    return res.sendStatus(400);
  }

  pictures = JSON.stringify(pictures.split("|"));

  if (dm == 'on') { dm = true } else { dm = false }

  pool.query(`INSERT INTO products (brand_original, brand_translation, "type", title_original, title_translation, description, pictures, volume, price, price_factor, amount, weight, exists, "case", dm, discount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, [brand, brand_translation, type, title_original, title_translation, description, pictures, volume, price.replace(',', '.'), price_factor, amount, weight, 1, box, dm, 0], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    res.redirect('/account?status=success');
  });
});

app.get('/catalog/product/:id', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE id = $1 LIMIT 1`, [req.params.id], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    let rows = result.rows;
    rows = rows.map((row) => {
      row.pictures = JSON.parse(row.pictures);
      row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
      return row;
    });

    res.render('product', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows, cart: req.cookies.cart ? (JSON.parse(req.cookies.cart)).items : null });
  });
});

app.get('/catalog', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  if (req.query.search) {
    const filter = `%${req.query.search.toLowerCase().replace('/', '')}%`;

    pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE (LOWER(title_original) LIKE $1 OR LOWER(title_translation) LIKE $2) AND visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END LIMIT 90`, [filter, filter], (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      let rows = result.rows;
      rows = rows.map((row) => {
        row.pictures = JSON.parse(row.pictures);
        row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
        return row;
      });

      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, search: req.query.search.replace('/', ''), data: rows, cart: cartLength > 0 ? cartLength : null });
    });
  } else {
    // Если параметр "GET" не указан, выводим все записи
    pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END LIMIT 90`, (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      let rows = result.rows;
      rows = rows.map((row) => {
        row.pictures = JSON.parse(row.pictures);
        row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
        return row;
      });

      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows, cart: cartLength > 0 ? cartLength : null });
    });
  }
});

app.get('/catalog/newest', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE visibility = true ORDER BY id DESC LIMIT 30`, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    let rows = result.rows;
    rows = rows.map((row) => {
      row.pictures = JSON.parse(row.pictures);
      row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
      return row;
    });

    let cartLength;

    if (req.cookies.cart) {
      cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
    } else {
      cartLength = 0;
    }

    res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows, cart: cartLength > 0 ? cartLength : null });
  });
});

app.get('/catalog/denkmit', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/denkmit/kitchen', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', 'kitchen', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/denkmit/washing', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', 'washing', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/denkmit/wc', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', 'wc', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/denkmit/cleaning', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', 'cleaning', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/denkmit/fresh', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', 'fresh', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/denkmit/other', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Denkmit', 'other', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/balea', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Balea', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/balea/hair', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Balea', 'hair', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/balea/skin', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Balea', 'skin', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/balea/body', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Balea', 'body', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/balea/shave', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Balea', 'shave', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/balea/hygiene', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Balea', 'hygiene', query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      console.log(err);
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/alverde', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Alverde', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/dontodent', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Dontodent', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/mivolis', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Mivolis', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/frosch', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Frosch', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/profissimo', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Profissimo', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/babylove', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(req.originalUrl + '/');
  }

  getDataDB('Babylove', null, query = (req.query.search) ? req.query.search.replace('/', '') : null)
    .then(rows => {
      let cartLength;

      if (req.cookies.cart) {
        cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
      } else {
        cartLength = 0;
      }

      res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.path, search: (req.query.search) ? req.query.search.replace('/', '') : null, data: rows, cart: cartLength > 0 ? cartLength : null });
    })
    .catch(err => {
      return res.status(500).send('Internal Server Error');
    });
});

app.get('/catalog/other', (req, res) => {
  if (!req.originalUrl.endsWith('/')) return res.redirect(req.originalUrl + '/');

  pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE visibility = true AND brand_original != 'Denkmit' AND brand_original != 'Balea' AND brand_original != 'Balea MEN' AND brand_original != 'Balea MED' AND brand_original != 'Alverde' AND brand_original != 'Dontodent' AND brand_original != 'Mivolis' AND brand_original != 'Frosch' AND brand_original != 'Profissimo' AND brand_original != 'Babylove' ORDER BY id DESC`, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Internal Server Error');
    }

    let rows = result.rows;
    rows = rows.map((row) => {
      row.pictures = JSON.parse(row.pictures);
      row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
      return row;
    });

    let cartLength;

    if (req.cookies.cart) {
      cartLength = Object.keys(JSON.parse(req.cookies.cart).items).length;
    } else {
      cartLength = 0;
    }

    res.render('catalog', { user: (req.session.isAuthenticated) ? true : false, url: req.originalUrl, data: rows, cart: cartLength > 0 ? cartLength : null });
  });
});

app.get('/media/:uuid', (req, res) => {
  const imagePath = path.join(__dirname, '/media/', `${req.params.uuid}`);

  if (fs.existsSync(imagePath)) {
    res.sendFile(imagePath);
  } else {
    res.status(404);
  }
});

async function getDataDB(filter, type = null, query = null) {
  try {
    if (query != null) {
      if (type != null) {
        const filter_query = '%' + query.toLowerCase().replace('/', '') + '%';

        const result = await pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE brand_original LIKE $1 AND type = $2 AND (LOWER(title_original) LIKE $3 OR LOWER(title_translation) LIKE $4) AND visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END`, [filter + '%', type, filter_query, filter_query]);

        let rows = result.rows;
        rows = rows.map((row) => {
          row.pictures = JSON.parse(row.pictures);
          row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
          return row;
        });

        return rows;
      } else {
        const filter_query = '%' + query.toLowerCase().replace('/', '') + '%';

        const result = await pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE brand_original LIKE $1 AND (LOWER(title_original) LIKE $2 OR LOWER(title_translation) LIKE $3) AND visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END`, [filter + '%', filter_query, filter_query]);

        let rows = result.rows;
        rows = rows.map((row) => {
          row.pictures = JSON.parse(row.pictures);
          row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
          return row;
        });

        return rows;
      }
    } else {
      if (type != null) {
        const result = await pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE brand_original LIKE $1 AND type = $2 AND visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END`, [filter + '%', type]);

        let rows = result.rows;
        rows = rows.map((row) => {
          row.pictures = JSON.parse(row.pictures);
          row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
          return row;
        });

        return rows;
      } else {
        const result = await pool.query(`SELECT *, CEIL((price / 100) * (100 + price_factor) * 100) / 100 AS price_total FROM products WHERE brand_original LIKE $1 AND visibility = true ORDER BY CASE WHEN exists = 1 THEN 1 WHEN exists = 2 THEN 2 WHEN exists = 0 THEN 3 END`, [filter + '%']);

        let rows = result.rows;
        rows = rows.map((row) => {
          row.pictures = JSON.parse(row.pictures);
          row.price_total = ((parseFloat(row.price_total) * euro_coefficient).toFixed(2)).replace('.', ',');
          return row;
        });

        return rows;
      }
    }
  } catch (error) {
    throw error;
  }
}

async function checkAdminUser(userId) {
  try {
    const result = await pool.query('SELECT admin FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    return user && user.admin === true;
  } catch (error) {
    throw error;
  }
}

const options = {
  key: fs.readFileSync('config/private.key'),
  cert: fs.readFileSync('config/certificate.crt')
};
let port = 80;

let server = http.createServer(app);

if (process.argv[2] && process.argv[2] === '-https') {
  port = 443;
  server = https.createServer(options, app);
}

server.listen(port, () => {
  console.log(`[${new Date().getHours()}:${new Date().getMinutes()}:${new Date().getSeconds()}] > The server is running on port ${port}`.toUpperCase());
});

